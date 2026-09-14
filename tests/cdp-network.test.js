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

test('a userinfo credential in a url is stripped structurally', async () => {
  const cdp = createCdp();
  // No secrets() supplied: this must still be redacted, because the credential
  // measured in documentURL was NOT the live lockfile password.
  const tailer = new NetworkTailer({ cdp, config: CONFIG, delay: async () => {} });
  await tailer.start();

  sendRequest(cdp, { url: 'https://riot:sTaLePassw0rd@127.0.0.1:33870/index.html' });
  finish(cdp);

  const [entry] = tailer.tail().entries;
  assert.equal(entry.url, 'https://riot:***@127.0.0.1:33870/index.html');
  assert.ok(!entry.url.includes('sTaLePassw0rd'));
});

test('the live password is stripped from a url that has no userinfo', async () => {
  const cdp = createCdp();
  const tailer = new NetworkTailer({ cdp, config: CONFIG, delay: async () => {}, secrets: () => ['L1vePass'] });
  await tailer.start();

  sendRequest(cdp, { url: 'https://127.0.0.1:1/lol-x?token=L1vePass' });
  finish(cdp);

  const [entry] = tailer.tail().entries;
  assert.equal(entry.url, 'https://127.0.0.1:1/lol-x?token=***');
});

test('the live password is stripped from postData', async () => {
  const cdp = createCdp();
  const tailer = new NetworkTailer({ cdp, config: CONFIG, delay: async () => {}, secrets: () => ['L1vePass'] });
  await tailer.start();

  sendRequest(cdp, { method: 'POST', postData: '{"password":"L1vePass"}' });
  finish(cdp);

  const [entry] = tailer.tail().entries;
  assert.equal(entry.postData, '{"password":"***"}');
});

test('the initiator url is redacted too', async () => {
  const cdp = createCdp();
  const tailer = new NetworkTailer({ cdp, config: CONFIG, delay: async () => {} });
  await tailer.start();

  cdp.emit('Network.requestWillBeSent', {
    requestId: '1',
    request: { url: 'https://127.0.0.1:1/lol-x', method: 'GET' },
    type: 'Fetch',
    timestamp: 100,
    wallTime: 1700000000,
    initiator: {
      type: 'script',
      stack: { callFrames: [{ functionName: 'f', url: 'https://riot:sTaLePassw0rd@127.0.0.1:1/p.js', lineNumber: 3 }] }
    }
  });
  finish(cdp);

  const [entry] = tailer.tail().entries;
  assert.equal(entry.initiator.url, 'https://riot:***@127.0.0.1:1/p.js');
  assert.equal(entry.initiator.functionName, 'f');
  assert.equal(entry.initiator.line, 3);
});

test('postData is capped and says so', async () => {
  const cdp = createCdp();
  const tailer = new NetworkTailer({ cdp, config: CONFIG, delay: async () => {} });
  await tailer.start();

  sendRequest(cdp, { method: 'POST', postData: 'x'.repeat(900) });
  finish(cdp);

  const [entry] = tailer.tail().entries;
  assert.ok(entry.postData.startsWith('x'.repeat(512)));
  assert.match(entry.postData, /truncated from 900/);
});

test('a GET carries no postData', async () => {
  const cdp = createCdp();
  const tailer = new NetworkTailer({ cdp, config: CONFIG, delay: async () => {} });
  await tailer.start();

  sendRequest(cdp);
  finish(cdp);

  assert.equal(tailer.tail().entries[0].postData, null);
});

test('a reattach entry records the target change and clears in-flight requests', async () => {
  const cdp = createCdp();
  const tailer = new NetworkTailer({ cdp, config: CONFIG, delay: async () => {} });
  await tailer.start();

  sendRequest(cdp, { id: 'dies-with-the-target' });
  assert.equal(tailer.statusSnapshot().inflight, 1);

  cdp.targetId = 'T2';
  cdp.emitClose();
  await new Promise((resolve) => setImmediate(resolve));

  const reattach = tailer.tail().entries.find((e) => e.kind === 'reattach');
  assert.ok(reattach, 'a renderer restart must be visible in the timeline');
  assert.equal(reattach.previousTargetId, 'T1');
  assert.equal(reattach.targetId, 'T2');
  assert.equal(tailer.statusSnapshot().inflight, 0, 'requestIds do not survive a reattach');
});

