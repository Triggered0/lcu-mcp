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

async function tailerWithTraffic() {
  const cdp = createCdp();
  const tailer = new NetworkTailer({ cdp, config: CONFIG, delay: async () => {} });
  await tailer.start();

  sendRequest(cdp, { id: 'a', url: 'https://127.0.0.1:1/lol-summoner/v1/current-summoner' });
  respond(cdp, { id: 'a', status: 200 });
  finish(cdp, { id: 'a' });

  sendRequest(cdp, { id: 'b', url: 'https://127.0.0.1:1/lol-missing', method: 'POST', postData: '{}' });
  respond(cdp, { id: 'b', status: 404 });
  finish(cdp, { id: 'b' });

  sendRequest(cdp, { id: 'c', url: 'https://127.0.0.1:1/lol-gone' });
  cdp.emit('Network.loadingFailed', { requestId: 'c', timestamp: 100.01, errorText: 'net::ERR_ABORTED' });

  return { cdp, tailer };
}

test('tail throws when the tailer is not running', async () => {
  const tailer = new NetworkTailer({ cdp: createCdp(), config: CONFIG, delay: async () => {} });
  assert.throws(() => tailer.tail(), /not running/);
});

test('tail returns every entry by default', async () => {
  const { tailer } = await tailerWithTraffic();
  assert.equal(tailer.tail().entries.length, 3);
});

test('urlContains matches case-insensitively', async () => {
  const { tailer } = await tailerWithTraffic();
  const { entries } = tailer.tail({ urlContains: 'SUMMONER' });
  assert.deepEqual(entries.map((e) => e.requestId), ['a']);
});

test('method is matched case-insensitively', async () => {
  const { tailer } = await tailerWithTraffic();
  assert.deepEqual(tailer.tail({ method: 'post' }).entries.map((e) => e.requestId), ['b']);
});

test('status matches exactly', async () => {
  const { tailer } = await tailerWithTraffic();
  assert.deepEqual(tailer.tail({ status: 404 }).entries.map((e) => e.requestId), ['b']);
});

test('minStatus catches the 4xx that failedOnly misses', async () => {
  const { tailer } = await tailerWithTraffic();

  assert.deepEqual(tailer.tail({ failedOnly: true }).entries.map((e) => e.requestId), ['c']);
  assert.deepEqual(
    tailer.tail({ minStatus: 400 }).entries.map((e) => e.requestId),
    ['b'],
    'a 404 arrives as an ordinary response, so failedOnly alone would answer "what broke" wrongly'
  );
});

test('a cursor returns only what is new', async () => {
  const { cdp, tailer } = await tailerWithTraffic();
  const first = tailer.tail();

  sendRequest(cdp, { id: 'd' });
  finish(cdp, { id: 'd' });

  const second = tailer.tail({ cursor: first.cursor });
  assert.deepEqual(second.entries.map((e) => e.requestId), ['d']);
});

test('limit caps the page and reports the remainder', async () => {
  const { tailer } = await tailerWithTraffic();
  const page = tailer.tail({ limit: 2 });
  assert.equal(page.entries.length, 2);
  assert.equal(page.remaining, 1);
});

test('in-flight requests are reported outside the buffer', async () => {
  const cdp = createCdp();
  const tailer = new NetworkTailer({ cdp, config: CONFIG, delay: async () => {} });
  await tailer.start();

  sendRequest(cdp, { id: 'hung', url: 'https://127.0.0.1:1/lol-slow' });

  const page = tailer.tail();
  assert.equal(page.entries.length, 0);
  assert.deepEqual(page.inflight.map((r) => r.requestId), ['hung'], 'a hung request must still be visible');
  assert.equal(page.inflight[0].url, 'https://127.0.0.1:1/lol-slow');
});

test('a reattach entry survives every filter', async () => {
  const cdp = createCdp();
  const tailer = new NetworkTailer({ cdp, config: CONFIG, delay: async () => {} });
  await tailer.start();
  cdp.targetId = 'T2';
  cdp.emitClose();
  await new Promise((resolve) => setImmediate(resolve));

  const { entries } = tailer.tail({ method: 'GET', minStatus: 500 });
  assert.deepEqual(entries.map((e) => e.kind), ['reattach'], 'a renderer restart is context for whatever you are reading');
});

test('summary throws when the tailer is not running', async () => {
  const tailer = new NetworkTailer({ cdp: createCdp(), config: CONFIG, delay: async () => {} });
  assert.throws(() => tailer.summary(), /not running/);
});

test('summary collapses repeated polls into one group', async () => {
  const cdp = createCdp();
  const tailer = new NetworkTailer({ cdp, config: CONFIG, delay: async () => {} });
  await tailer.start();

  for (let i = 0; i < 5; i += 1) {
    sendRequest(cdp, { id: `p${i}`, url: 'https://127.0.0.1:1/lol-gameflow/v1/gameflow-phase', ts: 100 });
    respond(cdp, { id: `p${i}`, status: 200 });
    finish(cdp, { id: `p${i}`, ts: 100.002, bytes: 100 });
  }
  sendRequest(cdp, { id: 'other', url: 'https://127.0.0.1:1/lol-summoner/v1/current-summoner' });
  respond(cdp, { id: 'other', status: 200 });
  finish(cdp, { id: 'other', bytes: 494 });

  const { total, groups } = tailer.summary();

  assert.equal(total, 6);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].count, 5, 'groups are ordered by count, busiest first');
  assert.equal(groups[0].url, 'https://127.0.0.1:1/lol-gameflow/v1/gameflow-phase');
  assert.equal(groups[0].method, 'GET');
  assert.deepEqual(groups[0].statuses, { 200: 5 });
  assert.equal(groups[0].totalBytes, 500);
  assert.equal(groups[0].p50DurationMs, 2);
});

test('summary strips the query string when grouping', async () => {
  const cdp = createCdp();
  const tailer = new NetworkTailer({ cdp, config: CONFIG, delay: async () => {} });
  await tailer.start();

  sendRequest(cdp, { id: '1', url: 'https://127.0.0.1:1/lol-x?a=1' });
  finish(cdp, { id: '1' });
  sendRequest(cdp, { id: '2', url: 'https://127.0.0.1:1/lol-x?a=2' });
  finish(cdp, { id: '2' });

  const { groups } = tailer.summary();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].url, 'https://127.0.0.1:1/lol-x');
  assert.equal(groups[0].count, 2);
});

test('summary counts failures and mixed statuses separately', async () => {
  const cdp = createCdp();
  const tailer = new NetworkTailer({ cdp, config: CONFIG, delay: async () => {} });
  await tailer.start();

  sendRequest(cdp, { id: '1', url: 'https://127.0.0.1:1/lol-x' });
  respond(cdp, { id: '1', status: 200 });
  finish(cdp, { id: '1' });
  sendRequest(cdp, { id: '2', url: 'https://127.0.0.1:1/lol-x' });
  respond(cdp, { id: '2', status: 500 });
  finish(cdp, { id: '2' });
  sendRequest(cdp, { id: '3', url: 'https://127.0.0.1:1/lol-x' });
  cdp.emit('Network.loadingFailed', { requestId: '3', timestamp: 100.01, errorText: 'net::ERR_ABORTED' });

  const { groups } = tailer.summary();
  assert.deepEqual(groups[0].statuses, { 200: 1, 500: 1, failed: 1 });
});

test('summary honours urlContains and method filters', async () => {
  const cdp = createCdp();
  const tailer = new NetworkTailer({ cdp, config: CONFIG, delay: async () => {} });
  await tailer.start();

  sendRequest(cdp, { id: '1', url: 'https://127.0.0.1:1/lol-a' });
  finish(cdp, { id: '1' });
  sendRequest(cdp, { id: '2', url: 'https://127.0.0.1:1/lol-b', method: 'POST' });
  finish(cdp, { id: '2' });

  assert.equal(tailer.summary({ urlContains: 'lol-b' }).groups.length, 1);
  assert.equal(tailer.summary({ method: 'post' }).groups[0].url, 'https://127.0.0.1:1/lol-b');
});

test('summary excludes reattach entries', async () => {
  const cdp = createCdp();
  const tailer = new NetworkTailer({ cdp, config: CONFIG, delay: async () => {} });
  await tailer.start();
  cdp.targetId = 'T2';
  cdp.emitClose();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(tailer.summary(), { total: 0, groups: [] });
});

test('body throws when the tailer is not running', async () => {
  const tailer = new NetworkTailer({ cdp: createCdp(), config: CONFIG, delay: async () => {} });
  await assert.rejects(() => tailer.body('1'), /not running/);
});

test('body fetches the response body on demand', async () => {
  const cdp = createCdp();
  cdp.bodies['1'] = { body: '"InProgress"', base64Encoded: false };
  const tailer = new NetworkTailer({ cdp, config: CONFIG, delay: async () => {} });
  await tailer.start();

  sendRequest(cdp, { id: '1', url: 'https://127.0.0.1:1/lol-gameflow/v1/gameflow-phase' });
  respond(cdp, { id: '1', status: 200 });
  finish(cdp, { id: '1' });

  const result = await tailer.body('1');

  assert.equal(result.requestId, '1');
  assert.equal(result.url, 'https://127.0.0.1:1/lol-gameflow/v1/gameflow-phase');
  assert.equal(result.status, 200);
  assert.equal(result.base64Encoded, false);
  assert.equal(result.body, '"InProgress"');
  assert.ok(
    cdp.sent.some((s) => s.method === 'Network.getResponseBody' && s.params.requestId === '1'),
    'bodies are not buffered, so this must reach the renderer'
  );
});

test('body redacts the live password out of the payload', async () => {
  const cdp = createCdp();
  cdp.bodies['1'] = { body: '{"pw":"L1vePass"}', base64Encoded: false };
  const tailer = new NetworkTailer({ cdp, config: CONFIG, delay: async () => {}, secrets: () => ['L1vePass'] });
  await tailer.start();

  sendRequest(cdp, { id: '1' });
  finish(cdp, { id: '1' });

  assert.equal((await tailer.body('1')).body, '{"pw":"***"}');
});

test('a base64 body is passed through untouched', async () => {
  const cdp = createCdp();
  cdp.bodies['1'] = { body: 'AAAA', base64Encoded: true };
  const tailer = new NetworkTailer({ cdp, config: CONFIG, delay: async () => {}, secrets: () => ['AAAA'] });
  await tailer.start();

  sendRequest(cdp, { id: '1' });
  finish(cdp, { id: '1' });

  const result = await tailer.body('1');
  assert.equal(result.base64Encoded, true);
  assert.equal(result.body, 'AAAA', 'substring redaction on base64 would corrupt it');
});

test('body names an unknown requestId rather than returning nothing', async () => {
  const cdp = createCdp();
  const tailer = new NetworkTailer({ cdp, config: CONFIG, delay: async () => {} });
  await tailer.start();

  await assert.rejects(() => tailer.body('nope'), /No buffered request with id nope/);
});

test('body refuses a requestId from a previous renderer incarnation', async () => {
  const cdp = createCdp();
  const tailer = new NetworkTailer({ cdp, config: CONFIG, delay: async () => {} });
  await tailer.start();

  sendRequest(cdp, { id: 'old' });
  finish(cdp, { id: 'old' });

  cdp.targetId = 'T2';
  cdp.emitClose();
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(
    () => tailer.body('old'),
    /previous renderer incarnation/,
    'an empty body would read as "the response was empty"'
  );
});

test('body surfaces the renderer eviction error unchanged', async () => {
  const cdp = createCdp();
  const tailer = new NetworkTailer({ cdp, config: CONFIG, delay: async () => {} });
  await tailer.start();

  sendRequest(cdp, { id: '1' });
  finish(cdp, { id: '1' });
  // cdp.bodies has no '1', so the fake throws the way the real CDP does.

  await assert.rejects(() => tailer.body('1'), /No resource with given identifier found/);
});



