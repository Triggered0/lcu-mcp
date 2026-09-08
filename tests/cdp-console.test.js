import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConsoleTailer, renderArg } from '../src/cdp/console.js';

function fakeClock(start = 1000) {
  let t = start;
  return { now: () => (t += 1), wall: () => t + 500_000 };
}

function fakeCdp() {
  const listeners = new Map();
  const closeListeners = new Set();
  const sent = [];
  return {
    sent,
    target: { id: 'PAGE-1' },
    emit(method, params) {
      for (const h of listeners.get(method) ?? []) h(params);
    },
    emitClose() {
      for (const h of closeListeners) h();
    },
    on(method, handler) {
      const list = listeners.get(method) ?? new Set();
      list.add(handler);
      listeners.set(method, list);
      return () => list.delete(handler);
    },
    onClose(handler) {
      closeListeners.add(handler);
      return () => closeListeners.delete(handler);
    },
    async attach() {},
    async send(method, params) {
      sent.push({ method, params });
      return {};
    },
    statusSnapshot() {
      return { attached: true, targetId: this.target.id };
    },
    close() {}
  };
}

function harness({ secrets = () => [], config = {} } = {}) {
  const cdp = fakeCdp();
  const tailer = new ConsoleTailer({
    cdp,
    config: { cdpConsoleBufferSize: 100, ...config },
    secrets,
    clock: fakeClock(),
    delay: async () => {}
  });
  return { cdp, tailer };
}

const consoleEvent = (overrides = {}) => ({
  type: 'log',
  timestamp: 1_700_000_000_123,
  args: [{ type: 'string', value: 'hello' }],
  stackTrace: { callFrames: [{ functionName: 'onPhase', url: 'https://riot:0/plugin.js', lineNumber: 41 }] },
  ...overrides
});

test('start enables Runtime and reports the target', async () => {
  const { cdp, tailer } = harness();
  const result = await tailer.start();
  assert.ok(cdp.sent.some((s) => s.method === 'Runtime.enable'));
  assert.equal(result.targetId, 'PAGE-1');
  tailer.stop();
});

test('tail before start is an error, not an empty success', async () => {
  const { tailer } = harness();
  assert.throws(() => tailer.tail({}), /not running/i);
});

test('tail after stop is an error too', async () => {
  const { tailer } = harness();
  await tailer.start();
  tailer.stop();
  assert.throws(() => tailer.tail({}), /not running/i);
});

test('a console call is buffered with both clocks', async () => {
  const { cdp, tailer } = harness();
  await tailer.start();
  cdp.emit('Runtime.consoleAPICalled', consoleEvent());

  const { entries } = tailer.tail({ limit: 100 });
  const entry = entries.find((e) => e.kind === 'console');
  assert.equal(entry.level, 'log');
  assert.equal(entry.args, 'hello');
  assert.equal(entry.pageTs, 1_700_000_000_123, 'the page clock is preserved');
  assert.ok(typeof entry.ts === 'number', 'our anchored clock is recorded too');
  assert.ok(typeof entry.wallTs === 'number', 'and our raw wall clock');
  assert.equal(entry.targetId, 'PAGE-1');
  assert.match(entry.stackTop, /onPhase/);
  tailer.stop();
});

test('an exception is buffered with its description', async () => {
  const { cdp, tailer } = harness();
  await tailer.start();
  cdp.emit('Runtime.exceptionThrown', {
    timestamp: 1_700_000_000_500,
    exceptionDetails: {
      text: 'Uncaught',
      exception: { description: 'TypeError: socket is null' },
      stackTrace: { callFrames: [{ functionName: 'reconnect', url: 'p.js', lineNumber: 7 }] }
    }
  });
  const entry = tailer.tail({ limit: 100 }).entries.find((e) => e.kind === 'exception');
  assert.equal(entry.description, 'TypeError: socket is null');
  assert.equal(entry.pageTs, 1_700_000_000_500);
  tailer.stop();
});

test('the LCU password is redacted before it enters the buffer', async () => {
  const { cdp, tailer } = harness({ secrets: () => ['super-secret-pw'] });
  await tailer.start();
  cdp.emit('Runtime.consoleAPICalled', consoleEvent({
    args: [{ type: 'string', value: 'connecting to wss://riot:super-secret-pw@127.0.0.1:29669/' }]
  }));

  const text = JSON.stringify(tailer.tail({ limit: 100 }));
  assert.ok(!text.includes('super-secret-pw'), 'the password must never be stored');
  assert.ok(text.includes('***'));
  tailer.stop();
});

test('a password in an exception description is redacted too', async () => {
  const { cdp, tailer } = harness({ secrets: () => ['super-secret-pw'] });
  await tailer.start();
  cdp.emit('Runtime.exceptionThrown', {
    timestamp: 1,
    exceptionDetails: { text: 'failed on wss://riot:super-secret-pw@127.0.0.1:1/', exception: {} }
  });
  assert.ok(!JSON.stringify(tailer.tail({ limit: 100 })).includes('super-secret-pw'));
  tailer.stop();
});

test('level filters console entries', async () => {
  const { cdp, tailer } = harness();
  await tailer.start();
  cdp.emit('Runtime.consoleAPICalled', consoleEvent({ type: 'log' }));
  cdp.emit('Runtime.consoleAPICalled', consoleEvent({ type: 'error' }));
  const { entries } = tailer.tail({ level: 'error', limit: 100 });
  assert.equal(entries.filter((e) => e.kind === 'console').length, 1);
  tailer.stop();
});

test('an uncaught exception survives a level:error filter', async () => {
  const { cdp, tailer } = harness();
  await tailer.start();
  cdp.emit('Runtime.consoleAPICalled', consoleEvent({ type: 'log' }));
  cdp.emit('Runtime.exceptionThrown', {
    timestamp: 1,
    exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: socket is null' } }
  });
  const { entries } = tailer.tail({ level: 'error', limit: 100 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'exception', 'filtering for errors must not hide exceptions');
  tailer.stop();
});

test('text matches case-insensitively across args and exception text', async () => {
  const { cdp, tailer } = harness();
  await tailer.start();
  cdp.emit('Runtime.consoleAPICalled', consoleEvent({ args: [{ type: 'string', value: 'Socket CLOSED' }] }));
  cdp.emit('Runtime.consoleAPICalled', consoleEvent({ args: [{ type: 'string', value: 'all good' }] }));
  const { entries } = tailer.tail({ text: 'socket closed', limit: 100 });
  assert.equal(entries.length, 1);
  tailer.stop();
});

test('renderArg prefers value, then description, then type', () => {
  assert.equal(renderArg({ type: 'string', value: 'hi' }), 'hi');
  assert.equal(renderArg({ type: 'number', value: 42 }), '42');
  assert.equal(renderArg({ type: 'object', description: 'Error: boom' }), 'Error: boom');
  assert.equal(renderArg({ type: 'object', subtype: 'null' }), 'object');
  assert.equal(renderArg({ type: 'undefined' }), 'undefined');
});

test('renderArg caps a very long argument', () => {
  const rendered = renderArg({ type: 'string', value: 'x'.repeat(5000) });
  assert.ok(rendered.length < 600, `rendered length ${rendered.length} should be capped`);
  assert.match(rendered, /truncated/);
});

test('a disconnect re-attaches and records the reattach with both target ids', async () => {
  const { cdp, tailer } = harness();
  await tailer.start();
  cdp.emit('Runtime.consoleAPICalled', consoleEvent({ args: [{ type: 'string', value: 'before' }] }));

  cdp.target.id = 'PAGE-2'; // the renderer reloaded under us
  cdp.emitClose();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  cdp.emit('Runtime.consoleAPICalled', consoleEvent({ args: [{ type: 'string', value: 'after' }] }));

  const { entries } = tailer.tail({ limit: 100 });
  const reattach = entries.find((e) => e.kind === 'reattach');
  assert.ok(reattach, 'a reattach entry was recorded');
  assert.equal(reattach.previousTargetId, 'PAGE-1');
  assert.equal(reattach.targetId, 'PAGE-2');
  assert.ok(reattach.gapMs >= 0);

  const args = entries.filter((e) => e.kind === 'console').map((e) => e.args);
  assert.deepEqual(args, ['before', 'after'], 'buffering continued across the reload');
  tailer.stop();
});

test('Runtime.enable is re-issued on the new socket', async () => {
  const { cdp, tailer } = harness();
  await tailer.start();
  const before = cdp.sent.filter((s) => s.method === 'Runtime.enable').length;
  cdp.emitClose();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(cdp.sent.filter((s) => s.method === 'Runtime.enable').length, before + 1);
  tailer.stop();
});

test('a reattach survives a level filter that would exclude everything else', async () => {
  const { cdp, tailer } = harness();
  await tailer.start();
  cdp.emit('Runtime.consoleAPICalled', consoleEvent({ type: 'log' }));
  cdp.emitClose();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  const { entries } = tailer.tail({ level: 'error', limit: 100 });
  assert.ok(entries.some((e) => e.kind === 'reattach'), 'the reload is context, not noise');
  tailer.stop();
});

test('a failed re-attach retries and does not lose the tailer', async () => {
  const { cdp, tailer } = harness();
  await tailer.start();
  let failures = 0;
  const realAttach = cdp.attach;
  cdp.attach = async () => {
    failures += 1;
    if (failures === 1) throw new Error('CDP unavailable on port 8888');
    return realAttach.call(cdp);
  };
  cdp.emitClose();
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));

  assert.ok(failures >= 2, 'the supervisor retried');
  assert.equal(tailer.statusSnapshot().running, true);
  tailer.stop();
});

test('stop orphans an in-flight re-attach loop', async () => {
  const cdp = fakeCdp();
  let release;
  const tailer = new ConsoleTailer({
    cdp,
    config: { cdpConsoleBufferSize: 100 },
    clock: fakeClock(),
    delay: () => new Promise((r) => { release = r; })
  });
  await tailer.start();
  const before = cdp.sent.length;
  cdp.emitClose();
  await new Promise((r) => setImmediate(r));

  tailer.stop();
  release();
  await new Promise((r) => setImmediate(r));

  assert.equal(cdp.sent.length, before, 'nothing was sent after stop');
});
