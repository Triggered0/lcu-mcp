import { WebSocket } from 'ws';
import { backoffDelay } from '../backoff.js';
import { createClock } from '../clock.js';
import { redactSecrets } from '../redact.js';
import { decodeEventFrame, subscribeEndpoint, truncateData } from './ingest.js';
import { TimelineBuffer } from './timeline.js';

export { backoffDelay };

export const LIFECYCLE_KINDS = ['start', 'stop', 'restart', 'open', 'close', 'error', 'gap'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Injected callbacks and library internals can reject with a non-Error, and
// `undefined.message` in a status field is worse than the value itself.
const errorMessage = (err) => (err instanceof Error ? err.message : String(err));

export class WampRecorder {
  #socket = null;
  #running = false;
  #buffer = null;
  #stats = new Map();
  #startedAt = null;
  #mode = 'firehose';
  #uris = [];
  #lastError = null;
  #knownPasswords = new Set();
  // Identity token for the one reconnect loop allowed to run. `null` means no
  // loop owns the recorder. A token rather than a boolean so stop() can orphan
  // an in-flight loop by clearing the field, without a later start() being
  // locked out and without the orphan clearing a flag its successor holds.
  #reconnectOwner = null;
  #lastCloseTs = null;
  #sink = null;

  constructor({ client, config, wsFactory, delay = sleep, clock = createClock() }) {
    this.client = client;
    this.config = config;
    this.delay = delay;
    this.clock = clock;
    this.wsFactory =
      wsFactory ??
      (({ url, ca }) => new WebSocket(url, { ca, headers: { 'Content-Type': 'application/json' } }));
  }

  // A recording whose start time cannot be trusted is worse than no recording,
  // because conclusions get drawn from it. So a second start is an error that
  // reports enough for the caller to decide whether discarding is safe, and
  // `restart` drops the old buffer AND the old socket rather than reusing
  // either — keeping old frames has the same misdating problem, quieter.
  async start({ uris = [], restart = false } = {}) {
    if (this.#running && !restart) {
      throw new Error(
        `A recording is already running: started at ${new Date(this.#startedAt).toISOString()} ` +
          `holding ${this.#buffer.length} entries. Dump it first, or pass restart: true to discard it.`
      );
    }

    const previousStartedAt = this.#startedAt;
    const previousEntries = this.#buffer?.length ?? 0;
    const wasRunning = this.#running;
    if (wasRunning) this.#teardown();

    this.#buffer = new TimelineBuffer({
      maxEntries: this.config.wampRecordBufferSize,
      maxBytes: this.config.wampRecordMaxBytes,
      clock: this.clock
    });
    this.#stats = new Map();
    this.#mode = uris.length > 0 ? 'uris' : 'firehose';
    this.#uris = [...uris];
    this.#running = true;
    this.#startedAt = this.clock.wall();

    // The restart entry is the first entry of the NEW buffer, so what was
    // discarded is itself on the record.
    if (wasRunning) {
      this.#push({ kind: 'restart', previousStartedAt, previousEntries });
    }
    this.#push({
      kind: 'start',
      uris: this.#uris,
      mode: this.#mode,
      bufferSize: this.config.wampRecordBufferSize,
      maxBytes: this.config.wampRecordMaxBytes,
      payloadCap: this.config.wampRecordPayloadCap
    });

    await this.#connect(0);
    return { startedAt: this.#startedAt, mode: this.#mode, uris: this.#uris };
  }

  async #connect(attempt) {
    const creds = await this.client.credentials();
    if (creds?.password) this.#knownPasswords.add(creds.password);
    // The password-in-URL form is the one verified against the live client.
    // Never log this URL.
    const url = `wss://riot:${creds.password}@127.0.0.1:${creds.port}/`;
    const socket = this.wsFactory({ url, ca: this.client.ca });
    this.#socket = socket;

    socket.on('message', (raw) => this.#ingest(socket, raw));
    socket.on('error', (err) => {
      this.#record(socket, { kind: 'error', message: this.#redact(`socket error: ${err?.code ?? errorMessage(err)}`) });
      this.#lastError = this.#redact(`socket error: ${err?.code ?? errorMessage(err)}`);
    });

    try {
      await new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
        // A socket can close without ever emitting 'error' when the client
        // exits mid-handshake. Without this the promise never settles and the
        // MCP tool call hangs forever.
        socket.once('close', () => reject(new Error('recorder socket closed before open')));
      });
      if (!this.#running || this.#socket !== socket) {
        throw new Error('recorder stopped before the socket opened');
      }
      for (const endpoint of this.#subscribeEndpoints()) {
        socket.send(JSON.stringify([5, endpoint]));
      }
    } catch (err) {
      if (this.#socket === socket) this.#socket = null;
      this.#closeQuietly(socket);
      throw err;
    }

    this.#push({ kind: 'open', port: creds.port, attempt });
    // Registered only now that the socket is live: before the handshake
    // completes a close *is* the failure that rejects the promise above.
    socket.on('close', (code, reason) => this.#onClose(socket, code, reason));
  }

  #subscribeEndpoints() {
    return this.#mode === 'firehose' ? ['OnJsonApiEvent'] : this.#uris.map(subscribeEndpoint);
  }

  #onClose(socket, code, reason) {
    if (!this.#running || socket !== this.#socket) return;
    const stored = this.#push({
      kind: 'close',
      code: code ?? null,
      reason: reason ? String(reason) : '',
      wasClean: code === 1000
    });
    this.#lastCloseTs = stored.ts;
    this.#socket = null;
    // Fire and forget: no MCP call is waiting on this.
    this.#reconnect();
  }

  async #reconnect() {
    if (this.#reconnectOwner !== null) return;
    const owner = Symbol('reconnect');
    this.#reconnectOwner = owner;
    const sinceTs = this.#lastCloseTs;
    try {
      for (let attempt = 0; this.#running && this.#reconnectOwner === owner; attempt += 1) {
        await this.delay(backoffDelay(attempt));
        if (!this.#running || this.#reconnectOwner !== owner) return;
        try {
          // The port changes when the client restarts, so the cached
          // credentials must not be trusted across a reconnect.
          this.client.invalidate?.();
          await this.#connect(attempt + 1);
        } catch (err) {
          this.#lastError = this.#redact(`reconnect failed: ${errorMessage(err)}`);
          this.#push({ kind: 'error', message: this.#lastError });
          continue;
        }
        this.#push({
          kind: 'gap',
          durationMs: sinceTs === null ? null : this.clock.now() - sinceTs,
          sinceTs
        });
        return;
      }
    } finally {
      if (this.#reconnectOwner === owner) this.#reconnectOwner = null;
    }
  }

  attachSink(sink) {
    this.#sink = sink;
  }

  // One choke point so that no entry can reach the buffer without also
  // reaching the file, and vice versa.
  #push(entry) {
    const stored = this.#buffer.push(entry);
    this.#sink?.write(stored);
    return stored;
  }

  #record(socket, entry) {
    // A superseded or stopped socket keeps emitting for a while. Without this
    // identity check its frames land in the buffer too, so one LCU event is
    // recorded once per orphaned socket and stop() does not stop the recorder.
    if (!this.#running || socket !== this.#socket) return;
    this.#push(entry);
  }

  #ingest(socket, raw) {
    if (!this.#running || socket !== this.#socket) return;
    const event = decodeEventFrame(raw);
    if (event === null) return;

    // Ground truth needs "a frame arrived on this URI at time T"; the payload
    // matters only for the handful of URIs under active correlation. Capping
    // the rest is what makes the firehose affordable.
    const cap = this.#payloadCapFor(event.uri);
    const { data, truncated } = truncateData(event.data, cap);
    const stored = this.#push({
      kind: 'event',
      uri: event.uri,
      eventType: event.eventType,
      endpoint: event.endpoint,
      data,
      truncated
    });
    this.#countUri(event.uri, stored.ts);
  }

  #payloadCapFor(uri) {
    const full = this.config.wampRecordFullPayloadUris ?? [];
    const exempt = typeof uri === 'string' && full.some((prefix) => uri.startsWith(prefix));
    return exempt ? Infinity : this.config.wampRecordPayloadCap;
  }

  // Held outside the ring buffer so they survive eviction: under a firehose an
  // evicted event is otherwise indistinguishable from an absent one.
  #countUri(uri, ts) {
    if (typeof uri !== 'string') return;
    const current = this.#stats.get(uri);
    if (current === undefined) {
      this.#stats.set(uri, { count: 1, firstTs: ts, lastTs: ts });
      return;
    }
    current.count += 1;
    current.lastTs = ts;
  }

  #redact(message) {
    if (typeof message !== 'string' || this.#knownPasswords.size === 0) return message;
    return redactSecrets(message, [...this.#knownPasswords]);
  }

  #closeQuietly(socket) {
    try {
      socket?.close();
    } catch {
      // already gone
    }
  }

  #teardown() {
    this.#running = false;
    this.#reconnectOwner = null;
    const socket = this.#socket;
    this.#socket = null;
    this.#closeQuietly(socket);
  }

  dump({ uri = null, since = null, until = null, kinds = null, limit = 100, cursor = 0 } = {}) {
    if (this.#buffer === null) {
      return { entries: [], stats: {}, dropped: 0, cursor: 0, remaining: 0, running: false, startedAt: null };
    }
    // A uri filter narrows events only. Lifecycle entries carry no uri and are
    // usually the answer, so only an explicit `kinds` can exclude them.
    const predicate = uri === null ? null : (e) => typeof e.uri !== 'string' || e.uri.startsWith(uri);
    const page = this.#buffer.select({ cursor, since, until, limit, kinds, predicate });
    return {
      ...page,
      stats: Object.fromEntries(this.#stats),
      running: this.#running,
      startedAt: this.#startedAt
    };
  }

  stop(reason = 'tool') {
    if (!this.#running) return { stopped: false, entries: this.#buffer?.length ?? 0 };
    const socket = this.#socket;
    this.#running = false;
    this.#reconnectOwner = null;
    this.#socket = null;
    this.#closeQuietly(socket);
    // Pushed after #running is false so the identity-checked #record path
    // cannot also fire for the close this triggers.
    this.#push({ kind: 'stop', reason });
    return { stopped: true, entries: this.#buffer.length };
  }

  statusSnapshot() {
    return {
      running: this.#running,
      startedAt: this.#startedAt,
      mode: this.#mode,
      uris: [...this.#uris],
      entries: this.#buffer?.length ?? 0,
      bytes: this.#buffer?.bytes ?? 0,
      droppedTotal: this.#buffer?.droppedTotal ?? 0,
      lastError: this.#lastError
    };
  }
}
