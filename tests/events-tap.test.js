import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RingBuffer } from '../src/lcu/buffer.js';
import { LcuEventTap, RECONNECT_URI, backoffDelay } from '../src/lcu/events.js';

class FakeSocket extends EventEmitter {
  sent = [];
  closed = false;
  send(data) { this.sent.push(data); }
  close() { this.closed = true; this.emit('close', 1000); }
  terminate() { this.closed = true; }
}

function harness({ filters = [] } = {}) {
  const sockets = [];
  const buffer = new RingBuffer(100);
  const tap = new LcuEventTap({
    client: { credentials: async () => ({ port: 29669, password: 'pw' }) },
    buffer,
    wsFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    delay: async () => {}
  });
  return { tap, buffer, sockets, filters };
}

function frame(uri, data = { ok: true }, eventType = 'Update') {
  return JSON.stringify([8, 'OnJsonApiEvent', { eventType, uri, data }]);
}

test('backoffDelay doubles from 1s and caps at 30s', () => {
  assert.equal(backoffDelay(0), 1000);
  assert.equal(backoffDelay(1), 2000);
  assert.equal(backoffDelay(4), 16000);
  assert.equal(backoffDelay(5), 30000);
  assert.equal(backoffDelay(50), 30000);
});

// `client.credentials()` is an async function: even though it resolves
// instantly, awaiting it (as #connect must, to learn the port/password
// before it has a URL to open a socket with) always costs at least one
// microtask tick in JS, so the fake socket does not exist the instant
// start() is called. Flushing one tick before touching sockets[N] lets the
// queued continuation run first, same as the setImmediate flush later in
// this file uses around the reconnect.
const flush = () => new Promise((r) => setImmediate(r));

test('start subscribes to OnJsonApiEvent', async () => {
  const { tap, sockets } = harness();
  const started = tap.start();
  await flush();
  sockets[0].emit('open');
  await started;
  assert.deepEqual(JSON.parse(sockets[0].sent[0]), [5, 'OnJsonApiEvent']);
  tap.stop();
});

test('events land in the buffer and the empty ack is skipped', async () => {
  const { tap, buffer, sockets } = harness();
  const started = tap.start();
  await flush();
  sockets[0].emit('open');
  await started;
  sockets[0].emit('message', Buffer.alloc(0));
  sockets[0].emit('message', frame('/lol-gameflow/v1/session'));
  assert.equal(buffer.length, 1);
  assert.equal(buffer.since(0, 10).entries[0].uri, '/lol-gameflow/v1/session');
  tap.stop();
});

test('filters are applied at ingest', async () => {
  const { tap, buffer, sockets } = harness();
  const started = tap.start(['/lol-champ-select/']);
  await flush();
  sockets[0].emit('open');
  await started;
  sockets[0].emit('message', frame('/lol-gameflow/v1/session'));
  sockets[0].emit('message', frame('/lol-champ-select/v1/session'));
  assert.equal(buffer.length, 1);
  tap.stop();
});

test('oversized data is stored truncated', async () => {
  const { tap, buffer, sockets } = harness();
  const started = tap.start();
  await flush();
  sockets[0].emit('open');
  await started;
  sockets[0].emit('message', frame('/lol-loot/v1/player-loot', { blob: 'x'.repeat(20000) }));
  const [entry] = buffer.since(0, 10).entries;
  assert.equal(entry.truncated, true);
  tap.stop();
});

test('restarting replaces filters and keeps the buffer', async () => {
  const { tap, buffer, sockets } = harness();
  let started = tap.start(['/lol-gameflow/']);
  await flush();
  sockets[0].emit('open');
  await started;
  sockets[0].emit('message', frame('/lol-gameflow/v1/session'));

  started = tap.start(['/lol-champ-select/']);
  await started;
  assert.equal(buffer.length, 1, 'buffer survives a restart');
  assert.deepEqual(tap.statusSnapshot().filters, ['/lol-champ-select/']);

  const socket = sockets[sockets.length - 1];
  socket.emit('message', frame('/lol-gameflow/v1/session'));
  assert.equal(buffer.length, 1, 'old filter no longer matches');
  socket.emit('message', frame('/lol-champ-select/v1/session'));
  assert.equal(buffer.length, 2);
  tap.stop();
});

test('an unexpected close reconnects and marks the gap', async () => {
  const { tap, buffer, sockets } = harness();
  const started = tap.start();
  await flush();
  sockets[0].emit('open');
  await started;

  sockets[0].emit('close', 1006);
  await new Promise((r) => setImmediate(r));
  sockets[1].emit('open');
  await new Promise((r) => setImmediate(r));

  assert.equal(sockets.length, 2, 'a new socket was opened');
  const marker = buffer.since(0, 10).entries.find((e) => e.uri === RECONNECT_URI);
  assert.ok(marker, 'a reconnect marker was pushed');
  assert.equal(marker.eventType, 'Reconnected');
  tap.stop();
});

test('stop prevents further reconnects', async () => {
  const { tap, sockets } = harness();
  const started = tap.start();
  await flush();
  sockets[0].emit('open');
  await started;
  tap.stop();
  await new Promise((r) => setImmediate(r));
  assert.equal(sockets.length, 1);
  assert.equal(tap.statusSnapshot().running, false);
});
