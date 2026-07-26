import { WebSocket } from 'ws';
import { decodeFrame, matchesFilters, truncateData } from './ingest.js';
import { redactSecrets } from '../redact.js';

export const RECONNECT_URI = '/__lcu_mcp__/reconnected';
const SUBSCRIBE_FRAME = JSON.stringify([5, 'OnJsonApiEvent']);

export function backoffDelay(attempt) {
  return Math.min(30000, 1000 * 2 ** attempt);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class LcuEventTap {
  #socket = null;
  #running = false;
  #attempts = 0;
  #lastError = null;
  #filters = [];
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
      this.#lastError = this.#redact(`connect failed: ${err.message}`);
      throw new Error(this.#redact(err.message));
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

    socket.on('message', (raw) => this.#ingest(raw));
    socket.on('error', (err) => {
      this.#lastError = this.#redact(`event socket error: ${err?.code ?? err?.message ?? 'unknown'}`);
    });
    socket.on('close', () => {
      if (this.#socket === socket) this.#socket = null;
      if (this.#running) this.#scheduleReconnect();
    });

    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    socket.send(SUBSCRIBE_FRAME);
    this.#attempts = 0;
  }

  async #scheduleReconnect() {
    const attempt = this.#attempts;
    this.#attempts += 1;
    await this.delay(backoffDelay(attempt));
    if (!this.#running) return;
    this.client.invalidate?.(); // the port may have changed with the restart
    try {
      await this.#connect();
      this.buffer.push({
        eventType: 'Reconnected',
        uri: RECONNECT_URI,
        data: { attempt: attempt + 1 },
        truncated: false
      });
    } catch (err) {
      this.#lastError = this.#redact(`reconnect failed: ${err.message}`);
      if (this.#running) this.#scheduleReconnect();
    }
  }

  #redact(message) {
    if (typeof message !== 'string' || this.#knownPasswords.size === 0) return message;
    return redactSecrets(message, [...this.#knownPasswords]);
  }

  #ingest(raw) {
    const event = decodeFrame(raw);
    if (event === null) return;
    if (!matchesFilters(event.uri, this.#filters)) return;
    const { data, truncated } = truncateData(event.data);
    this.buffer.push({ eventType: event.eventType, uri: event.uri, data, truncated });
  }

  stop() {
    this.#running = false;
    const socket = this.#socket;
    this.#socket = null;
    socket?.close();
  }

  statusSnapshot() {
    return {
      running: this.#running,
      connected: this.#socket !== null,
      filters: [...this.#filters],
      attempts: this.#attempts,
      buffered: this.buffer.length,
      lastError: this.#lastError
    };
  }
}
