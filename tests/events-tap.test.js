import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RingBuffer } from '../src/lcu/buffer.js';
import { LcuEventTap, RECONNECT_URI, backoffDelay } from '../src/lcu/events.js';

class FakeSocket extends EventEmitter {
  sent = [];
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.emit('close', 1000);
  }
}

const DEFAULT_CREDENTIALS = { port: 29669, password: 'pw' };

function harness({ credentials, ca = 'RIOT-ROOT-CA-PEM', wsFactory, delay, invalidate } = {}) {
  const sockets = [];
  const factoryArgs = [];
  const buffer = new RingBuffer(100);
  const calls = { credentials: 0, invalidate: 0, delay: 0 };
  const client = {
    ca,
    credentials: async () => {
      calls.credentials += 1;
      return credentials ? credentials(calls.credentials) : DEFAULT_CREDENTIALS;
    },
    invalidate: () => {
      calls.invalidate += 1;
      if (invalidate) invalidate(calls.invalidate);
    }
  };
  const tap = new LcuEventTap({
    client,
    buffer,
    wsFactory: (options) => {
      factoryArgs.push(options);
      if (wsFactory) return wsFactory(options);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    delay: async (ms) => {
      calls.delay += 1;
      if (delay) await delay(calls.delay, ms);
    }
  });
  return { tap, buffer, sockets, factoryArgs, calls };
}

function frame(uri, data = { ok: true }, eventType = 'Update') {
  return JSON.stringify([8, 'OnJsonApiEvent', { eventType, uri, data }]);
}

// `client.credentials()` is an async function: even though it resolves
// instantly, awaiting it (as #connect must, to learn the port and password
// before it has a URL to open a socket with) always costs at least one
// microtask tick in JS, so the fake socket does not exist the instant
// start() is called. Flushing one tick before touching sockets[N] lets the
// queued continuation run first. setImmediate lands after the whole microtask
// queue has drained, so one flush covers an entire connect or reconnect round.
const flush = () => new Promise((r) => setImmediate(r));

test('backoffDelay doubles from 1s and caps at 30s', () => {
  assert.equal(backoffDelay(0), 1000);
  assert.equal(backoffDelay(1), 2000);
  assert.equal(backoffDelay(4), 16000);
  assert.equal(backoffDelay(5), 30000);
  assert.equal(backoffDelay(50), 30000);
});

test('start subscribes to OnJsonApiEvent', async () => {
  const { tap, sockets } = harness();
  const started = tap.start();
  await flush();
  sockets[0].emit('open');
  await started;
  assert.deepEqual(JSON.parse(sockets[0].sent[0]), [5, 'OnJsonApiEvent']);
  tap.stop();
});

test('the socket is opened over wss with the pinned CA and nothing else', async () => {
  const { tap, sockets, factoryArgs } = harness({ ca: 'PINNED-RIOT-CA' });
  const started = tap.start();
  await flush();
  sockets[0].emit('open');
  await started;

  assert.equal(factoryArgs.length, 1);
  assert.equal(factoryArgs[0].url, 'wss://riot:pw@127.0.0.1:29669/');
  assert.equal(factoryArgs[0].ca, 'PINNED-RIOT-CA', 'the pinned CA reaches the socket');
  // TLS verification stays on, pinned to Riot's root CA: no option may weaken it.
  assert.deepEqual(
    Object.keys(factoryArgs[0]).sort(),
    ['ca', 'url'],
    'no extra socket option (rejectUnauthorized, checkServerIdentity, ...)'
  );
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
  await flush();
  sockets[1].emit('open');
  await flush();

  assert.equal(sockets.length, 2, 'a new socket was opened');
  const marker = buffer.since(0, 10).entries.find((e) => e.uri === RECONNECT_URI);
  assert.ok(marker, 'a reconnect marker was pushed');
  assert.equal(marker.eventType, 'Reconnected');
  tap.stop();
});

test('connected reports the handshake, not the existence of a socket', async () => {
  const { tap, sockets } = harness();
  const started = tap.start();
  await flush();
  assert.equal(sockets.length, 1);
  assert.equal(tap.statusSnapshot().connected, false, 'a socket object is not a connection');
  sockets[0].emit('open');
  await started;
  assert.equal(tap.statusSnapshot().connected, true);
  sockets[0].emit('close', 1006);
  assert.equal(tap.statusSnapshot().connected, false, 'a closed socket is not connected');
  tap.stop();
});

test('a failing reconnect opens exactly one socket per backoff round', async () => {
  const { tap, buffer, sockets } = harness();
  const started = tap.start();
  await flush();
  sockets[0].emit('open');
  await started;

  sockets[0].emit('close', 1006); // the League client exited

  for (let round = 1; round <= 5; round += 1) {
    await flush();
    assert.equal(sockets.length, round + 1, `round ${round} opened exactly one socket`);
    const socket = sockets[sockets.length - 1];
    // Real `ws` emits 'error' immediately followed by 'close' on a failed
    // handshake. Handling both as "schedule a reconnect" doubles the number of
    // independent loops every round.
    socket.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:29669'));
    socket.emit('close', 1006);
  }

  await flush();
  assert.equal(sockets.length, 7, 'still one socket per round after five failures');

  const live = sockets[6]; // the client came back
  live.emit('open');
  await flush();

  const entries = buffer.since(0, 100).entries;
  assert.equal(
    entries.filter((e) => e.uri === RECONNECT_URI).length,
    1,
    'exactly one reconnect marker'
  );
  live.emit('message', frame('/lol-gameflow/v1/session'));
  assert.equal(buffer.length, 2, 'the event is ingested exactly once');
  tap.stop();
});

test('a frame from a superseded socket reaches the buffer zero times', async () => {
  const { tap, buffer, sockets } = harness();
  const started = tap.start();
  await flush();
  sockets[0].emit('open');
  await started;

  sockets[0].emit('close', 1006);
  await flush();
  sockets[1].emit('open');
  await flush();
  assert.equal(sockets.length, 2);

  const before = buffer.length;
  sockets[0].emit('message', frame('/lol-gameflow/v1/session'));
  assert.equal(buffer.length, before, 'the replaced socket can no longer push');
  sockets[1].emit('message', frame('/lol-gameflow/v1/session'));
  assert.equal(buffer.length, before + 1, 'the live socket still can');
  tap.stop();
});

test('stop prevents further reconnects', async () => {
  const { tap, sockets } = harness();
  const started = tap.start();
  await flush();
  sockets[0].emit('open');
  await started;
  tap.stop();
  await flush();
  assert.equal(sockets.length, 1);
  assert.equal(tap.statusSnapshot().running, false);
});

test('no frame reaches the buffer after stop', async () => {
  const { tap, buffer, sockets } = harness();
  const started = tap.start();
  await flush();
  sockets[0].emit('open');
  await started;
  tap.stop();
  await flush();
  sockets[0].emit('message', frame('/lol-gameflow/v1/session'));
  assert.equal(buffer.length, 0, 'stop() leaves no path into the buffer');
  assert.equal(tap.statusSnapshot().running, false);
});

test('stop during an outage ends the reconnect loop', async () => {
  const { tap, buffer, sockets } = harness();
  const started = tap.start();
  await flush();
  sockets[0].emit('open');
  await started;

  sockets[0].emit('close', 1006);
  await flush();
  assert.equal(sockets.length, 2, 'a reconnect attempt is in flight');

  tap.stop();
  await flush();
  await flush();
  assert.equal(sockets.length, 2, 'no further sockets are opened after stop');

  sockets[1].emit('open'); // a late handshake must not revive the tap
  await flush();
  assert.equal(buffer.length, 0, 'no reconnect marker after stop');
  assert.equal(tap.statusSnapshot().running, false);
  assert.equal(tap.statusSnapshot().connected, false);
});

test('a failed start leaves the tap stopped and a later start genuinely retries', async () => {
  const { tap, sockets, calls } = harness({
    credentials: (call) => {
      if (call === 1) throw new Error('League client is not running');
      return { port: 12345, password: 'pw2' };
    }
  });

  await assert.rejects(tap.start(['/lol-champ-select/']), /League client is not running/);
  assert.equal(calls.credentials, 1);
  const failed = tap.statusSnapshot();
  assert.equal(failed.running, false, 'a failed start must not leave running true');
  assert.equal(failed.connected, false);
  assert.match(failed.lastError, /connect failed: League client is not running/);

  const started = tap.start(['/lol-champ-select/']);
  await flush();
  assert.equal(calls.credentials, 2, 'the second start calls credentials() again');
  assert.equal(sockets.length, 1, 'the second start really opens a socket');
  sockets[0].emit('open');
  await started;
  assert.equal(tap.statusSnapshot().connected, true);
  tap.stop();
});

test('a socket that closes without erroring settles start instead of hanging', { timeout: 2000 }, async () => {
  const { tap, sockets } = harness();
  const started = tap.start();
  await flush();
  sockets[0].emit('close', 1006); // no 'error' first
  await assert.rejects(started, /closed before open/);
  assert.equal(tap.statusSnapshot().running, false);
  assert.equal(tap.statusSnapshot().connected, false);
});

test('the password is redacted from the thrown error and the status snapshot', async () => {
  const password = 'sup3r-s3cret-pw';
  const { tap } = harness({
    credentials: () => ({ port: 29669, password }),
    // What real `ws` does when the password makes the URL unparseable: it
    // throws from its constructor with the whole credential URL in the message.
    wsFactory: ({ url }) => {
      throw new SyntaxError(`Invalid URL: ${url}`);
    }
  });

  await assert.rejects(tap.start(), (err) => {
    assert.ok(!err.message.includes(password), 'the thrown error leaks the password');
    assert.equal(err.message, 'Invalid URL: wss://riot:***@127.0.0.1:29669/');
    return true;
  });

  const { lastError } = tap.statusSnapshot();
  assert.ok(!lastError.includes(password), 'statusSnapshot().lastError leaks the password');
  assert.equal(lastError, 'connect failed: Invalid URL: wss://riot:***@127.0.0.1:29669/');
});

test('a throwing delay or invalidate is contained, never an unhandled rejection', async () => {
  const rejections = [];
  const onUnhandled = (err) => rejections.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    const { tap, sockets } = harness({
      delay: (call) => {
        if (call === 1) throw new Error('delay blew up');
      },
      invalidate: (call) => {
        if (call === 1) throw new Error('invalidate blew up');
      }
    });
    const started = tap.start();
    await flush();
    sockets[0].emit('open');
    await started;

    sockets[0].emit('close', 1006);
    await flush();
    await flush();

    assert.deepEqual(rejections, [], 'nothing escaped as an unhandled rejection');
    assert.match(tap.statusSnapshot().lastError, /reconnect failed: invalidate blew up/);
    assert.equal(sockets.length, 2, 'the loop survived both throws and retried');
    tap.stop();
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});
