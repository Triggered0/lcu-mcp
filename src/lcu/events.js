import { WebSocket } from 'ws';
import { decodeFrame, matchesFilters, truncateData } from './ingest.js';
import { redactSecrets } from '../redact.js';

export const RECONNECT_URI = '/__lcu_mcp__/reconnected';
const SUBSCRIBE_FRAME = JSON.stringify([5, 'OnJsonApiEvent']);

export function backoffDelay(attempt) {
  return Math.min(30000, 1000 * 2 ** attempt);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Injected callbacks and library internals can reject with a non-Error, and
// `undefined.message` in a status field is worse than the value itself.
const errorMessage = (err) => (err instanceof Error ? err.message : String(err));

export class LcuEventTap {
  #socket = null;
  #connected = false;
  #running = false;
  #attempts = 0;
  #lastError = null;
  #filters = [];
  // Identity token of the one reconnect loop allowed to run. `null` means no
  // loop owns the tap. A token rather than a boolean so stop() can orphan an
  // in-flight loop (it clears the field) without a later start() being locked
  // out, and so the orphan cannot clear the flag its successor is holding.
  #reconnectOwner = null;
  // Every LCU password ever seen, so any stray occurrence in a network/library
  // error message (this connection's, or a stale one from a prior port) gets
  // scrubbed before it is stored or surfaced. The password must never appear
  // in an error message, a status snapshot, or a buffered event.
  #knownPasswords = new Set();

  constructor({ client, buffer, wsFactory, delay = sleep }) {
    this.client = client;
    this.buffer = buffer;
    this.delay = delay;
    this.wsFactory =
      wsFactory ??
      (({ url, ca }) => new WebSocket(url, { ca, headers: { 'Content-Type': 'application/json' } }));
  }

  async start(filters = []) {
    this.#filters = Array.isArray(filters) ? [...filters] : [];
    if (this.#running) return; // filters replaced, buffer and socket kept
    this.#running = true;
    this.#attempts = 0;
    try {
      await this.#connect();
    } catch (err) {
      // Leave the tap fully stopped. Staying `running` with no socket and no
      // reconnect scheduled makes every later start() a silent no-op: the
      // caller is told the watch is live while events never arrive.
      this.#lastError = this.#redact(`connect failed: ${errorMessage(err)}`);
      this.#shutdown();
      throw new Error(this.#redact(errorMessage(err)));
    }
  }

  async #connect() {
    const creds = await this.client.credentials();
    if (creds?.password) this.#knownPasswords.add(creds.password);
    // The password-in-URL form is the one verified against the live client.
    // Never log this URL.
    const url = `wss://riot:${creds.password}@127.0.0.1:${creds.port}/`;
    const socket = this.wsFactory({ url, ca: this.client.ca });
    this.#socket = socket;

    socket.on('message', (raw) => this.#ingest(socket, raw));
    socket.on('error', (err) => {
      this.#lastError = this.#redact(`event socket error: ${err?.code ?? err?.message ?? 'unknown'}`);
    });

    try {
      await new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
        // A socket can close without ever emitting 'error' — the client exits
        // mid-handshake. Without this the promise never settles, so start()
        // never returns and the MCP tool call that made it hangs forever.
        socket.once('close', () => reject(new Error('event socket closed before open')));
      });
      // stop() nulls #socket and a newer #connect() overwrites it: either way
      // this handshake has been superseded and must not become the live socket.
      if (!this.#running || this.#socket !== socket) {
        throw new Error('event tap stopped before the socket opened');
      }
      socket.send(SUBSCRIBE_FRAME);
    } catch (err) {
      if (this.#socket === socket) {
        this.#socket = null;
        this.#connected = false;
      }
      this.#closeQuietly(socket);
      throw err;
    }

    this.#connected = true;
    this.#attempts = 0;
    // Registered only now that the socket is live. Before the handshake
    // completes a close *is* the failure that rejects the promise above, and it
    // belongs to whoever awaits #connect(); handling it here as well makes one
    // failed attempt schedule two reconnect loops, which then doubles per round.
    socket.on('close', () => {
      if (this.#socket === socket) {
        this.#socket = null;
        this.#connected = false;
      }
      if (this.#running) this.#scheduleReconnect();
    });
  }

  #scheduleReconnect() {
    if (this.#reconnectOwner !== null || !this.#running) return;
    const owner = {};
    this.#reconnectOwner = owner;
    // Fire-and-forget from a socket event handler, so #reconnectLoop has to
    // swallow everything: an unhandled rejection kills the whole MCP server.
    void this.#reconnectLoop(owner);
  }

  async #reconnectLoop(owner) {
    try {
      while (this.#running && this.#reconnectOwner === owner) {
        const attempt = this.#attempts;
        this.#attempts += 1;
        try {
          // delay and invalidate are injected, so both live inside the guarded
          // region: a throw or rejection from either must not escape.
          await this.delay(backoffDelay(attempt));
          if (!this.#running || this.#reconnectOwner !== owner) return;
          this.client.invalidate?.(); // the port may have changed with the restart
          await this.#connect();
        } catch (err) {
          this.#lastError = this.#redact(`reconnect failed: ${errorMessage(err)}`);
          continue;
        }
        this.buffer.push({
          eventType: 'Reconnected',
          uri: RECONNECT_URI,
          data: { attempt: attempt + 1 },
          truncated: false
        });
        return;
      }
    } catch (err) {
      this.#lastError = this.#redact(`reconnect failed: ${errorMessage(err)}`);
    } finally {
      if (this.#reconnectOwner === owner) this.#reconnectOwner = null;
    }
  }

  #redact(message) {
    if (typeof message !== 'string' || this.#knownPasswords.size === 0) return message;
    return redactSecrets(message, [...this.#knownPasswords]);
  }

  #ingest(socket, raw) {
    // A superseded or stopped socket keeps emitting for a while. Without this
    // identity check its frames are ingested too, so a single LCU event lands
    // in the buffer once per orphaned socket and stop() does not stop the tap.
    if (!this.#running || socket !== this.#socket) return;
    const event = decodeFrame(raw);
    if (event === null) return;
    if (!matchesFilters(event.uri, this.#filters)) return;
    const { data, truncated } = truncateData(event.data);
    this.buffer.push({ eventType: event.eventType, uri: event.uri, data, truncated });
  }

  // close() must not throw out of a cleanup path: on the start() failure path
  // it would replace the redacted error with an unredacted one.
  #closeQuietly(socket) {
    try {
      socket?.close();
    } catch {
      // already gone
    }
  }

  stop() {
    this.#shutdown();
  }

  // Leaves no path that can still reach the buffer: the tap is not running, the
  // live socket is detached (so #ingest rejects its frames) and closed, and any
  // in-flight reconnect loop is orphaned by clearing the owner token it holds.
  #shutdown() {
    this.#running = false;
    this.#connected = false;
    this.#reconnectOwner = null;
    const socket = this.#socket;
    this.#socket = null;
    this.#closeQuietly(socket);
  }

  statusSnapshot() {
    return {
      running: this.#running,
      // Set on 'open', cleared on 'close': a socket object existing is not a
      // connection, and reporting one that never opened as connected is a lie.
      connected: this.#connected,
      filters: [...this.#filters],
      attempts: this.#attempts,
      buffered: this.buffer.length,
      lastError: this.#lastError
    };
  }
}
