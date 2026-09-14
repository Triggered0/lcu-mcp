import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NetworkTailer } from '../src/cdp/network.js';

// A fake CDP socket: handlers are invoked synchronously by emit(), so tests
// never wait on real I/O and never need a running client.
export function createCdp({ targetId = 'T1' } = {}) {
  const handlers = new Map();
  const closeHandlers = new Set();
  return {
    sent: [],
    attached: true,
    targetId,
    bodies: {},
    on(method, handler) {
      const list = handlers.get(method) ?? new Set();
      list.add(handler);
      handlers.set(method, list);
      return () => list.delete(handler);
    },
    onClose(handler) {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    emit(method, params) {
      for (const h of handlers.get(method) ?? []) h(params);
    },
    emitClose() {
      for (const h of closeHandlers) h();
    },
    async attach() {
      this.attached = true;
    },
    async send(method, params) {
      this.sent.push({ method, params });
      if (method === 'Network.getResponseBody') {
        const found = this.bodies[params.requestId];
        if (!found) throw new Error('No resource with given identifier found');
        return found;
      }
      return {};
    },
    statusSnapshot() {
      return { attached: this.attached, targetId: this.targetId };
    },
    close() {
      this.attached = false;
    }
  };
}

export const CONFIG = { cdpNetworkBufferSize: 100 };

// Timestamps: CDP `timestamp` is monotonic seconds, `wallTime` is epoch seconds.
export function sendRequest(cdp, { id = '1', url = 'https://127.0.0.1:1/lol-x', method = 'GET', ts = 100, postData, type = 'Fetch' } = {}) {
  cdp.emit('Network.requestWillBeSent', {
    requestId: id,
    request: { url, method, ...(postData === undefined ? {} : { postData }) },
    type,
    timestamp: ts,
    wallTime: 1700000000,
    initiator: {
      type: 'script',
      stack: { callFrames: [{ functionName: 'doFetch', url: 'https://plugins/x.js', lineNumber: 12 }] }
    }
  });
}

export function respond(cdp, { id = '1', status = 200, mimeType = 'application/json' } = {}) {
  cdp.emit('Network.responseReceived', {
    requestId: id,
    response: { status, statusText: '', mimeType }
  });
}

export function finish(cdp, { id = '1', ts = 100.004, bytes = 494 } = {}) {
  cdp.emit('Network.loadingFinished', { requestId: id, timestamp: ts, encodedDataLength: bytes });
}

function makeTailer(cdp, overrides = {}) {
  return new NetworkTailer({ cdp, config: CONFIG, delay: async () => {}, ...overrides });
}

test('start enables the Network domain and records the target', async () => {
  const cdp = createCdp();
  const tailer = makeTailer(cdp);

  const started = await tailer.start();

  assert.deepEqual(cdp.sent.map((s) => s.method), ['Network.enable']);
  assert.equal(started.alreadyRunning, false);
  assert.equal(tailer.statusSnapshot().targetId, 'T1');
  assert.equal(tailer.statusSnapshot().running, true);
});

test('start is idempotent and does not re-enable', async () => {
  const cdp = createCdp();
  const tailer = makeTailer(cdp);

  await tailer.start();
  const second = await tailer.start();

  assert.equal(second.alreadyRunning, true);
  assert.deepEqual(cdp.sent.map((s) => s.method), ['Network.enable']);
});

test('a completed request produces exactly one entry', async () => {
  const cdp = createCdp();
  const tailer = makeTailer(cdp);
  await tailer.start();

  sendRequest(cdp);
  respond(cdp);
  finish(cdp);

  assert.equal(tailer.statusSnapshot().entries, 1);
});

test('an in-flight request is not in the buffer yet', async () => {
  const cdp = createCdp();
  const tailer = makeTailer(cdp);
  await tailer.start();

  sendRequest(cdp);
  respond(cdp);

  assert.equal(tailer.statusSnapshot().entries, 0, 'mutating a delivered entry would break cursor semantics');
});

test('the entry carries the measured fields', async () => {
  const cdp = createCdp();
  const tailer = makeTailer(cdp);
  await tailer.start();

  sendRequest(cdp, { url: 'https://127.0.0.1:1/lol-summoner/v1/current-summoner' });
  respond(cdp, { status: 200 });
  finish(cdp, { ts: 100.004, bytes: 494 });

  const [entry] = tailer.tail().entries;
  assert.equal(entry.kind, 'request');
  assert.equal(entry.requestId, '1');
  assert.equal(entry.targetId, 'T1');
  assert.equal(entry.method, 'GET');
  assert.equal(entry.url, 'https://127.0.0.1:1/lol-summoner/v1/current-summoner');
  assert.equal(entry.type, 'Fetch');
  assert.equal(entry.status, 200);
  assert.equal(entry.mimeType, 'application/json');
  assert.equal(entry.bytes, 494);
  assert.equal(entry.startedAt, 1700000000000, 'wallTime is epoch seconds, the entry stores epoch ms');
  assert.equal(entry.durationMs, 4);
  assert.equal(entry.failed, false);
});

test('a 404 is recorded as a status, not as a failure', async () => {
  const cdp = createCdp();
  const tailer = makeTailer(cdp);
  await tailer.start();

  sendRequest(cdp);
  respond(cdp, { status: 404 });
  finish(cdp, { bytes: 118 });

  const [entry] = tailer.tail().entries;
  assert.equal(entry.status, 404);
  assert.equal(entry.failed, false, 'the client delivers 404 as an ordinary response');
});

test('a transport failure is recorded as failed with its error text', async () => {
  const cdp = createCdp();
  const tailer = makeTailer(cdp);
  await tailer.start();

  sendRequest(cdp);
  cdp.emit('Network.loadingFailed', { requestId: '1', timestamp: 100.01, errorText: 'net::ERR_ABORTED' });

  const [entry] = tailer.tail().entries;
  assert.equal(entry.failed, true);
  assert.equal(entry.errorText, 'net::ERR_ABORTED');
  assert.equal(entry.status, null);
});

test('events for an unknown requestId are ignored', async () => {
  const cdp = createCdp();
  const tailer = makeTailer(cdp);
  await tailer.start();

  finish(cdp, { id: 'never-started' });

  assert.equal(tailer.statusSnapshot().entries, 0);
});

test('nothing is ingested before start or after stop', async () => {
  const cdp = createCdp();
  const tailer = makeTailer(cdp);

  sendRequest(cdp);
  finish(cdp);
  assert.equal(tailer.statusSnapshot().entries, 0);

  await tailer.start();
  tailer.stop();
  sendRequest(cdp, { id: '2' });
  finish(cdp, { id: '2' });
  assert.equal(tailer.statusSnapshot().entries, 0);
});

test('stop closes the socket and reports the entry count', async () => {
  const cdp = createCdp();
  const tailer = makeTailer(cdp);
  await tailer.start();
  sendRequest(cdp);
  finish(cdp);

  const stopped = tailer.stop();

  assert.deepEqual(stopped, { stopped: true, entries: 1 });
  assert.equal(cdp.attached, false);
  assert.equal(tailer.stop().stopped, false, 'stopping twice is not an error');
});
