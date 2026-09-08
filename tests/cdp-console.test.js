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
