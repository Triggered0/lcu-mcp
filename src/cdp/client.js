import { WebSocket } from 'ws';
import { findPageTarget } from './discover.js';

export class CdpClient {
  #socket = null;
  #target = null;
  #pending = new Map();
  #nextId = 1;
  #lastError = null;
  #attaching = null;
  #listeners = new Map();
  #closeListeners = new Set();

  constructor({ port, wsFactory = (url) => new WebSocket(url), discover = findPageTarget } = {}) {
    this.port = port;
    this.wsFactory = wsFactory;
    this.discover = discover;
  }

  async attach() {
    if (this.#socket) return;
    this.#attaching ??= this.#attachOnce().finally(() => {
      this.#attaching = null;
    });
    return this.#attaching;
  }

  async #attachOnce() {
    try {
      await this.#connect();
    } catch (err) {
      // Discovery may hold a stale target id after a UX restart; re-run it once.
      this.#lastError = err.message;
      try {
        await this.#connect();
      } catch (retryErr) {
        this.#lastError = retryErr.message;
        throw retryErr;
      }
    }
    this.#lastError = null;
  }

  async #connect() {
    const target = await this.discover(this.port);
    const socket = this.wsFactory(target.webSocketDebuggerUrl);

    socket.on('message', (raw) => this.#handleMessage(raw));
    socket.on('close', () => {
      if (this.#socket === socket) {
        this.#socket = null;
        this.#target = null;
      }
      for (const { reject } of this.#pending.values()) reject(new Error('CDP socket closed'));
      this.#pending.clear();
      this.#emit(this.#closeListeners, undefined);
    });
    socket.on('error', (err) => {
      this.#lastError = `CDP socket error: ${err?.code ?? err?.message ?? 'unknown'}`;
    });

    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    this.#socket = socket;
    this.#target = target;
  }

  #handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'));
    } catch {
      return;
    }
    if (message.id === undefined) {
      const handlers = this.#listeners.get(message.method);
      if (handlers) this.#emit(handlers, message.params ?? {});
      return;
    }
    const waiter = this.#pending.get(message.id);
    if (!waiter) return;
    this.#pending.delete(message.id);
    if (message.error) waiter.reject(new Error(`CDP ${message.error.code}: ${message.error.message}`));
    else waiter.resolve(message.result);
  }

  async send(method, params = {}) {
    await this.attach();
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#socket.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        this.#pending.delete(id);
        reject(err);
      }
    });
  }

  // CDP events arrive unsolicited, with a `method` and no `id`. Without a
  // dispatch they are dropped, which is why nothing could tail the console.
  on(method, handler) {
    const list = this.#listeners.get(method) ?? new Set();
    list.add(handler);
    this.#listeners.set(method, list);
    return () => list.delete(handler);
  }

  onClose(handler) {
    this.#closeListeners.add(handler);
    return () => this.#closeListeners.delete(handler);
  }

  #emit(handlers, arg) {
    for (const handler of handlers) {
      try {
        handler(arg);
      } catch {
        // A subscriber's failure must not stop the socket's message loop or
        // rob every later subscriber of the event.
      }
    }
  }

  // A page exception is data, not a failure: the whole point of evaluating a
  // probe is to learn what the page thinks, and "it threw, here is the stack"
  // is an answer. domQuery, whose contract is a value, throws on it instead.
  async evaluate(expression, { awaitPromise = false } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true
    });
    if (!result.exceptionDetails) return { value: result.result?.value, exceptionDetails: null };
    const details = result.exceptionDetails;
    return {
      value: result.result?.value,
      exceptionDetails: {
        text: details.text ?? null,
        description: details.exception?.description ?? null,
        lineNumber: details.lineNumber ?? null,
        columnNumber: details.columnNumber ?? null,
        stackTrace: (details.stackTrace?.callFrames ?? []).slice(0, 10).map((f) => ({
          functionName: f.functionName,
          url: f.url,
          lineNumber: f.lineNumber,
          columnNumber: f.columnNumber
        }))
      }
    };
  }

  async domQuery(selector, { all = false, props = [] } = {}) {
    const expression = `(() => {
      const sel = ${JSON.stringify(selector)};
      const props = ${JSON.stringify(props)};
      const describe = (el) => {
        const out = {
          tag: el.tagName,
          id: el.id || undefined,
          className: el.className || undefined,
          text: (el.textContent || '').trim().slice(0, 200) || undefined
        };
        for (const p of props) out[p] = el[p] ?? el.getAttribute(p) ?? undefined;
        return out;
      };
      const nodes = Array.from(document.querySelectorAll(sel));
      return ${all ? 'nodes.map(describe)' : 'nodes.length ? describe(nodes[0]) : null'};
    })()`;
    const { value, exceptionDetails } = await this.evaluate(expression);
    if (exceptionDetails) {
      throw new Error(`Page threw: ${exceptionDetails.description ?? exceptionDetails.text ?? 'unknown page exception'}`);
    }
    return value;
  }

  statusSnapshot() {
    return {
      attached: this.#socket !== null,
      port: this.port,
      targetId: this.#target?.id ?? null,
      targetTitle: this.#target?.title ?? null,
      lastError: this.#lastError
    };
  }

  close() {
    const socket = this.#socket;
    this.#socket = null;
    this.#target = null;
    socket?.close();
  }
}
