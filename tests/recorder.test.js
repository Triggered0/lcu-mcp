import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WampRecorder } from '../src/lcu/recorder.js';

class FakeSocket extends EventEmitter {
  sent = [];
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.emit('close', 1000, Buffer.from('bye'));
  }
}

const CREDENTIALS = { port: 29669, password: 'super-secret-pw' };

function fakeClock(start = 1000) {
  let t = start;
  return { now: () => (t += 1), wall: () => t + 500_000 };
}

function harness({ config = {}, delay } = {}) {
  const sockets = [];
  const factoryArgs = [];
  const calls = { credentials: 0, invalidate: 0, delay: 0 };
  const client = {
    ca: 'RIOT-ROOT-CA-PEM',
    credentials: async () => {
      calls.credentials += 1;
      return CREDENTIALS;
    },
    invalidate: () => {
      calls.invalidate += 1;
    }
  };
  const recorder = new WampRecorder({
    client,
    config: {
      wampRecordBufferSize: 100,
      wampRecordMaxBytes: 1_000_000,
      wampRecordPayloadCap: 512,
      wampRecordFullPayloadUris: ['/lol-gameflow/v1/gameflow-phase'],
      ...config
    },
    clock: fakeClock(),
    wsFactory: (options) => {
      factoryArgs.push(options);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    delay: async (ms) => {
      calls.delay += 1;
      if (delay) await delay(calls.delay, ms);
    }
  });
  return { recorder, sockets, factoryArgs, calls };
}

// The socket only exists after `client.credentials()` resolves, which costs at
// least one microtask tick, so `start()` is awaited before touching sockets[0].
async function started(h, options = {}) {
  const promise = h.recorder.start(options);
  await Promise.resolve();
  h.sockets[0]?.emit('open');
  await promise;
  return h.sockets[0];
}

function frame(uri, data = { ok: true }, endpoint = 'OnJsonApiEvent', eventType = 'Update') {
  return JSON.stringify([8, endpoint, { eventType, uri, data }]);
}

test('start subscribes to the firehose by default', async () => {
  const h = harness();
  const socket = await started(h);
  assert.deepEqual(JSON.parse(socket.sent[0]), [5, 'OnJsonApiEvent']);
  assert.equal(h.recorder.statusSnapshot().mode, 'firehose');
  h.recorder.stop();
});

test('start with uris subscribes per URI', async () => {
  const h = harness();
  const socket = await started(h, { uris: ['/lol-gameflow/v1/gameflow-phase', '/lol-champ-select/v1/session'] });
  assert.deepEqual(socket.sent.map((s) => JSON.parse(s)), [
    [5, 'OnJsonApiEvent_lol-gameflow_v1_gameflow-phase'],
    [5, 'OnJsonApiEvent_lol-champ-select_v1_session']
  ]);
  assert.equal(h.recorder.statusSnapshot().mode, 'uris');
  h.recorder.stop();
});

test('the socket url carries the credentials and the CA', async () => {
  const h = harness();
  await started(h);
  assert.equal(h.factoryArgs[0].url, 'wss://riot:super-secret-pw@127.0.0.1:29669/');
  assert.equal(h.factoryArgs[0].ca, 'RIOT-ROOT-CA-PEM');
  h.recorder.stop();
});

test('a start entry records the recording parameters before any frame', async () => {
  const h = harness();
  await started(h);
  const { entries } = h.recorder.dump({ limit: 100 });
  assert.equal(entries[0].kind, 'start');
  assert.equal(entries[0].mode, 'firehose');
  assert.equal(entries[0].payloadCap, 512);
  assert.equal(entries[1].kind, 'open');
  assert.equal(entries[1].port, 29669);
  h.recorder.stop();
});

test('events are recorded with their endpoint and uri', async () => {
  const h = harness();
  const socket = await started(h);
  socket.emit('message', frame('/lol-gameflow/v1/gameflow-phase', 'ChampSelect'));
  const { entries } = h.recorder.dump({ kinds: ['event'], limit: 100 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].uri, '/lol-gameflow/v1/gameflow-phase');
  assert.equal(entries[0].endpoint, 'OnJsonApiEvent');
  assert.equal(entries[0].data, 'ChampSelect');
  h.recorder.stop();
});

test('nothing is filtered at ingest, so the firehose keeps every URI', async () => {
  const h = harness();
  const socket = await started(h, { uris: ['/lol-gameflow/v1/gameflow-phase'] });
  socket.emit('message', frame('/lol-champ-select/v1/session'));
  socket.emit('message', frame('/lol-gameflow/v1/gameflow-phase'));
  const { entries } = h.recorder.dump({ kinds: ['event'], limit: 100 });
  assert.equal(entries.length, 2, 'ingest must not filter; filtering belongs at dump');
  h.recorder.stop();
});

test('payloads are capped except for the full-payload URIs', async () => {
  const h = harness({ config: { wampRecordPayloadCap: 32 } });
  const socket = await started(h);
  socket.emit('message', frame('/lol-champ-select/v1/session', { blob: 'x'.repeat(500) }));
  socket.emit('message', frame('/lol-gameflow/v1/gameflow-phase', { blob: 'y'.repeat(500) }));

  const { entries } = h.recorder.dump({ kinds: ['event'], limit: 100 });
  const capped = entries.find((e) => e.uri === '/lol-champ-select/v1/session');
  const full = entries.find((e) => e.uri === '/lol-gameflow/v1/gameflow-phase');
  assert.equal(capped.truncated, true);
  assert.equal(full.truncated, false);
  assert.ok(JSON.stringify(full.data).includes('y'.repeat(500)));
  h.recorder.stop();
});

test('per-URI stats survive eviction of the entries themselves', async () => {
  const h = harness({ config: { wampRecordBufferSize: 3 } });
  const socket = await started(h);
  for (let i = 0; i < 10; i += 1) socket.emit('message', frame('/lol-gameflow/v1/gameflow-phase'));

  const { stats, entries } = h.recorder.dump({ kinds: ['event'], limit: 100 });
  assert.ok(entries.length <= 3, 'entries were evicted');
  assert.equal(stats['/lol-gameflow/v1/gameflow-phase'].count, 10, 'the count is cumulative');
  assert.ok(stats['/lol-gameflow/v1/gameflow-phase'].lastTs > stats['/lol-gameflow/v1/gameflow-phase'].firstTs);
  h.recorder.stop();
});

test('stats make socket-alive-but-URI-quiet distinguishable from socket-dead', async () => {
  const h = harness();
  const socket = await started(h);
  socket.emit('message', frame('/lol-gameflow/v1/gameflow-phase'));
  socket.emit('message', frame('/lol-champ-select/v1/session'));
  socket.emit('message', frame('/lol-champ-select/v1/session'));

  const { stats } = h.recorder.dump({ limit: 100 });
  // Gameflow went quiet while champ-select kept flowing: the socket is alive.
  assert.equal(stats['/lol-gameflow/v1/gameflow-phase'].count, 1);
  assert.equal(stats['/lol-champ-select/v1/session'].count, 2);
  assert.ok(stats['/lol-champ-select/v1/session'].lastTs > stats['/lol-gameflow/v1/gameflow-phase'].lastTs);
  h.recorder.stop();
});

test('dump filters by uri prefix without dropping lifecycle entries', async () => {
  const h = harness();
  const socket = await started(h);
  socket.emit('message', frame('/lol-gameflow/v1/gameflow-phase'));
  socket.emit('message', frame('/lol-champ-select/v1/session'));

  const { entries } = h.recorder.dump({ uri: '/lol-gameflow/', limit: 100 });
  const kinds = entries.map((e) => e.kind);
  assert.ok(kinds.includes('start'), 'lifecycle entries survive a uri filter');
  assert.ok(kinds.includes('open'));
  const events = entries.filter((e) => e.kind === 'event');
  assert.equal(events.length, 1);
  assert.equal(events[0].uri, '/lol-gameflow/v1/gameflow-phase');
  h.recorder.stop();
});

test('stop records a stop entry with its reason and leaves the timeline readable', async () => {
  const h = harness();
  const socket = await started(h);
  socket.emit('message', frame('/a'));
  h.recorder.stop();

  const { entries, running } = h.recorder.dump({ limit: 100 });
  assert.equal(running, false);
  assert.equal(entries.at(-1).kind, 'stop');
  assert.equal(entries.at(-1).reason, 'tool');
});

test('a frame arriving on a superseded socket is ignored', async () => {
  const h = harness();
  const socket = await started(h);
  h.recorder.stop();
  socket.emit('message', frame('/a'));
  const events = h.recorder.dump({ kinds: ['event'], limit: 100 }).entries;
  assert.equal(events.length, 0);
});
