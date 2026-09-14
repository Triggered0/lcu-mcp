import { backoffDelay } from '../backoff.js';
import { createClock } from '../clock.js';
import { redactSecrets, redactUrl } from '../redact.js';
import { TimelineBuffer } from '../lcu/timeline.js';

// Measured live: POST bodies against the LCU are small JSON documents. The cap
// matches the console tailer's ARG_CAP so both tools truncate alike.
export const POST_DATA_CAP = 512;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cap(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… (truncated from ${text.length})`;
}

// Which code issued the request. Measured to be the single most useful field
// for "why did the client ask for this" — e.g. generalUtils.js:1876.
function initiatorTop(initiator) {
  const frame = initiator?.stack?.callFrames?.[0];
  if (!frame) return null;
  return {
    type: initiator?.type ?? null,
    functionName: frame.functionName || '(anonymous)',
    url: frame.url ?? null,
    line: frame.lineNumber ?? null
  };
}

export class NetworkTailer {
  #buffer = null;
  // CDP reports a request across three events. Holding the partial record here
  // and pushing once on completion keeps every buffered entry immutable, which
  // is what the seq cursor contract requires.
  #inflight = new Map();
  #running = false;
  #startedAt = null;
  #targetId = null;
  #unsubscribe = [];
  #reconnectOwner = null;
  #lastError = null;
  #lastDisconnectTs = null;

  constructor({ cdp, config, secrets = () => [], clock = createClock(), delay = sleep }) {
    this.cdp = cdp;
    this.config = config;
    this.secrets = secrets;
    this.clock = clock;
    this.delay = delay;
  }

  async start() {
    if (this.#running) {
      return { startedAt: this.#startedAt, targetId: this.#targetId, alreadyRunning: true };
    }
    this.#buffer = new TimelineBuffer({
      maxEntries: this.config.cdpNetworkBufferSize,
      clock: this.clock
    });
    this.#inflight = new Map();
    this.#running = true;
    this.#startedAt = this.clock.wall();
    this.#subscribe();
    await this.#enable();
    return { startedAt: this.#startedAt, targetId: this.#targetId, alreadyRunning: false };
  }

  #subscribe() {
    this.#unsubscribe = [
      this.cdp.on('Network.requestWillBeSent', (params) => this.#onRequest(params)),
      this.cdp.on('Network.responseReceived', (params) => this.#onResponse(params)),
      this.cdp.on('Network.loadingFinished', (params) => this.#onFinished(params)),
      this.cdp.on('Network.loadingFailed', (params) => this.#onFailed(params)),
      this.cdp.onClose(() => this.#onDisconnect())
    ];
  }

  async #enable() {
    await this.cdp.attach();
    await this.cdp.send('Network.enable');
    this.#targetId = this.cdp.statusSnapshot().targetId;
  }

  #cleanText(text) {
    if (typeof text !== 'string') return text;
    const secrets = this.secrets() ?? [];
    return secrets.length === 0 ? text : redactSecrets(text, secrets);
  }

  // Structural first, so a credential this process never learned is still
  // stripped; then the known-secret pass for anything left.
  #cleanUrl(url) {
    if (typeof url !== 'string') return url;
    return this.#cleanText(redactUrl(url));
  }

  #onRequest(params) {
    if (!this.#running) return;
    this.#inflight.set(params.requestId, {
      requestId: params.requestId,
      method: params.request?.method ?? null,
      url: params.request?.url ?? null,
      type: params.type ?? null,
      postData: params.request?.postData ?? null,
      initiator: initiatorTop(params.initiator),
      startedAt: typeof params.wallTime === 'number' ? Math.round(params.wallTime * 1000) : null,
      startTs: typeof params.timestamp === 'number' ? params.timestamp : null,
      status: null,
      statusText: null,
      mimeType: null
    });
  }

  #onResponse(params) {
    const pending = this.#inflight.get(params.requestId);
    if (!pending) return;
    pending.status = params.response?.status ?? null;
    pending.statusText = params.response?.statusText ?? null;
    pending.mimeType = params.response?.mimeType ?? null;
  }

  #onFinished(params) {
    this.#complete(params.requestId, {
      bytes: params.encodedDataLength ?? null,
      endTs: typeof params.timestamp === 'number' ? params.timestamp : null,
      failed: false,
      errorText: null
    });
  }

  #onFailed(params) {
    this.#complete(params.requestId, {
      bytes: null,
      endTs: typeof params.timestamp === 'number' ? params.timestamp : null,
      failed: true,
      errorText: params.errorText ?? null
    });
  }

  #complete(requestId, outcome) {
    if (!this.#running) return;
    const pending = this.#inflight.get(requestId);
    if (!pending) return;
    this.#inflight.delete(requestId);

    // CDP timestamps are monotonic seconds; the entry reports milliseconds.
    const durationMs =
      pending.startTs !== null && outcome.endTs !== null
        ? Number(((outcome.endTs - pending.startTs) * 1000).toFixed(3))
        : null;

    this.#buffer.push({
      kind: 'request',
      requestId,
      targetId: this.#targetId,
      method: pending.method,
      url: this.#cleanUrl(pending.url),
      type: pending.type,
      status: pending.status,
      statusText: pending.statusText,
      mimeType: pending.mimeType,
      bytes: outcome.bytes,
      startedAt: pending.startedAt,
      durationMs,
      initiator: pending.initiator === null ? null : { ...pending.initiator, url: this.#cleanUrl(pending.initiator.url) },
      postData: typeof pending.postData === 'string' ? this.#cleanText(cap(pending.postData, POST_DATA_CAP)) : null,
      failed: outcome.failed,
      errorText: this.#cleanText(outcome.errorText)
    });
  }

  #onDisconnect() {
    if (!this.#running) return;
    this.#lastDisconnectTs = this.clock.now();
    // Fire and forget: no MCP call is waiting on this.
    this.#reattach();
  }

  // When the client UI restarts, the target is destroyed. Without this the
  // tailer goes deaf at the worst possible moment and an empty buffer reads as
  // "the page made no requests".
  async #reattach() {
    if (this.#reconnectOwner !== null) return;
    const owner = Symbol('reattach');
    this.#reconnectOwner = owner;
    const previousTargetId = this.#targetId;
    const sinceTs = this.#lastDisconnectTs;
    try {
      for (let attempt = 0; this.#running && this.#reconnectOwner === owner; attempt += 1) {
        await this.delay(backoffDelay(attempt));
        if (!this.#running || this.#reconnectOwner !== owner) return;
        try {
          await this.#enable();
        } catch (err) {
          this.#lastError = this.#cleanText(err instanceof Error ? err.message : String(err));
          continue;
        }
        // requestIds are scoped to a target: everything in flight died with it.
        this.#inflight.clear();
        this.#buffer.push({
          kind: 'reattach',
          previousTargetId,
          targetId: this.#targetId,
          gapMs: sinceTs === null ? null : this.clock.now() - sinceTs
        });
        this.#lastError = null;
        return;
      }
    } finally {
      if (this.#reconnectOwner === owner) this.#reconnectOwner = null;
    }
  }

  // Replaced in full by Task 3.
  tail() {
    return this.#buffer.select({ cursor: 0, limit: 100 });
  }

  stop() {
    if (!this.#running) return { stopped: false, entries: this.#buffer?.length ?? 0 };
    this.#running = false;
    this.#reconnectOwner = null;
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe = [];
    const entries = this.#buffer.length;
    this.#inflight.clear();
    this.cdp.close();
    return { stopped: true, entries };
  }

  statusSnapshot() {
    return {
      running: this.#running,
      startedAt: this.#startedAt,
      targetId: this.#targetId,
      entries: this.#buffer?.length ?? 0,
      inflight: this.#inflight.size,
      droppedTotal: this.#buffer?.droppedTotal ?? 0,
      lastError: this.#lastError
    };
  }
}
