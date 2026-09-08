import { backoffDelay } from '../backoff.js';
import { createClock } from '../clock.js';
import { redactSecrets } from '../redact.js';
import { TimelineBuffer } from '../lcu/timeline.js';

export const ARG_CAP = 512;
export const ARGS_CAP = 2048;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cap(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… (truncated from ${text.length})`;
}

// consoleAPICalled delivers RemoteObjects. Deep-serialising them is expensive
// on a hot log path, so take the cheapest faithful representation available.
export function renderArg(arg) {
  if (arg === null || typeof arg !== 'object') return String(arg);
  if ('value' in arg) {
    const raw = typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value);
    return cap(String(raw), ARG_CAP);
  }
  if (typeof arg.description === 'string') return cap(arg.description, ARG_CAP);
  return String(arg.type ?? 'unknown');
}

function stackTop(stackTrace) {
  const frame = stackTrace?.callFrames?.[0];
  if (!frame) return null;
  const where = `${frame.url ?? ''}:${frame.lineNumber ?? '?'}`;
  return `${frame.functionName || '(anonymous)'} @ ${where}`;
}

export class ConsoleTailer {
  #buffer = null;
  #running = false;
  #startedAt = null;
  #targetId = null;
  #unsubscribe = [];
  #reconnectOwner = null;
  #lastError = null;

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
      maxEntries: this.config.cdpConsoleBufferSize,
      clock: this.clock
    });
    this.#running = true;
    this.#startedAt = this.clock.wall();
    this.#subscribe();
    await this.#enable();
    return { startedAt: this.#startedAt, targetId: this.#targetId };
  }

  #subscribe() {
    this.#unsubscribe = [
      this.cdp.on('Runtime.consoleAPICalled', (params) => this.#onConsole(params)),
      this.cdp.on('Runtime.exceptionThrown', (params) => this.#onException(params)),
      this.cdp.onClose(() => this.#onDisconnect())
    ];
  }

  async #enable() {
    await this.cdp.attach();
    await this.cdp.send('Runtime.enable');
    this.#targetId = this.cdp.statusSnapshot().targetId;
  }

  #redact(text) {
    if (typeof text !== 'string') return text;
    const secrets = this.secrets() ?? [];
    return secrets.length === 0 ? text : redactSecrets(text, secrets);
  }

  #onConsole(params) {
    if (!this.#running) return;
    const rendered = cap((params.args ?? []).map(renderArg).join(' '), ARGS_CAP);
    this.#buffer.push({
      kind: 'console',
      pageTs: params.timestamp ?? null,
      targetId: this.#targetId,
      level: params.type ?? 'log',
      args: this.#redact(rendered),
      stackTop: this.#redact(stackTop(params.stackTrace)),
      url: this.#redact(params.stackTrace?.callFrames?.[0]?.url ?? null)
    });
  }

  #onException(params) {
    if (!this.#running) return;
    const details = params.exceptionDetails ?? {};
    this.#buffer.push({
      kind: 'exception',
      pageTs: params.timestamp ?? null,
      targetId: this.#targetId,
      // Carried so that tail({ level: 'error' }) includes uncaught exceptions.
      // Filtering for errors and getting only console.error back would hide
      // the loudest evidence there is.
      level: 'error',
      text: this.#redact(details.text ?? null),
      description: this.#redact(details.exception?.description ?? null),
      stackTop: this.#redact(stackTop(details.stackTrace)),
      url: this.#redact(details.url ?? null)
    });
  }

  // Task 10 replaces this with the re-attach supervisor.
  #onDisconnect() {}

  tail({ cursor = 0, since = null, until = null, limit = 100, level = null, targetId = null, text = null } = {}) {
    if (!this.#running) {
      throw new Error(
        'The console tailer is not running, so there is nothing to tail. An empty result here ' +
          'would read as "the page logged nothing" when the truth is "nothing was listening". ' +
          'Call lol_cdp_console_start first.'
      );
    }
    const needle = text === null ? null : text.toLowerCase();
    // A reattach is context for whatever is being read, not noise: it survives
    // every filter except an explicit kinds selection.
    const predicate = (e) => {
      if (e.kind === 'reattach') return true;
      if (level !== null && e.level !== level) return false;
      if (targetId !== null && e.targetId !== targetId) return false;
      if (needle !== null) {
        const haystack = `${e.args ?? ''} ${e.text ?? ''} ${e.description ?? ''}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    };
    const page = this.#buffer.select({ cursor, since, until, limit, predicate });
    return {
      ...page,
      running: this.#running,
      attached: this.cdp.statusSnapshot().attached,
      targetId: this.#targetId,
      startedAt: this.#startedAt
    };
  }

  stop() {
    if (!this.#running) return { stopped: false, entries: this.#buffer?.length ?? 0 };
    this.#running = false;
    this.#reconnectOwner = null;
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe = [];
    this.cdp.close();
    return { stopped: true, entries: this.#buffer.length };
  }

  statusSnapshot() {
    return {
      running: this.#running,
      startedAt: this.#startedAt,
      targetId: this.#targetId,
      entries: this.#buffer?.length ?? 0,
      droppedTotal: this.#buffer?.droppedTotal ?? 0,
      lastError: this.#lastError
    };
  }
}
