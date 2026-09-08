import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerRecorderTools } from '../src/tools/recorder.js';

function ctxWith(recorder) {
  return { recorder, config: { configPath: 'config/allowlist.json' }, secrets: () => [] };
}

// Captures the handlers the tools register, so they can be called directly.
function register(recorder) {
  const handlers = new Map();
  const server = { registerTool: (name, _meta, handler) => handlers.set(name, handler) };
  registerRecorderTools(server, ctxWith(recorder));
  return handlers;
}

const parse = (result) => JSON.parse(result.content[0].text);

test('start passes uris and restart through and reports the mode', async () => {
  const calls = [];
  const handlers = register({
    start: async (options) => {
      calls.push(options);
      return { startedAt: 1700000000000, mode: 'uris', uris: options.uris };
    }
  });
  const result = await handlers.get('lol_wamp_record_start')({ uris: ['/lol-gameflow/v1/gameflow-phase'] });
  assert.deepEqual(calls[0], { uris: ['/lol-gameflow/v1/gameflow-phase'], restart: false });
  assert.equal(parse(result).mode, 'uris');
});

test('start defaults to the firehose when no uris are given', async () => {
  const calls = [];
  const handlers = register({
    start: async (options) => {
      calls.push(options);
      return { startedAt: 1, mode: 'firehose', uris: [] };
    }
  });
  await handlers.get('lol_wamp_record_start')({});
  assert.deepEqual(calls[0], { uris: [], restart: false });
});

test('a second start surfaces the recorder error rather than succeeding', async () => {
  const handlers = register({
    start: async () => {
      throw new Error('A recording is already running: started at X holding 12 entries.');
    }
  });
  const result = await handlers.get('lol_wamp_record_start')({});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /already running/);
  assert.match(result.content[0].text, /12 entries/);
});

test('dump forwards every filter and returns stats', async () => {
  const calls = [];
  const handlers = register({
    dump: (options) => {
      calls.push(options);
      return { entries: [], stats: { '/a': { count: 3 } }, dropped: 0, cursor: 0, remaining: 0, running: true, startedAt: 1 };
    }
  });
  const result = await handlers.get('lol_wamp_record_dump')({
    uri: '/lol-gameflow/',
    since: 100,
    until: 200,
    kinds: ['event'],
    limit: 50,
    cursor: 7
  });
  assert.deepEqual(calls[0], {
    uri: '/lol-gameflow/',
    since: 100,
    until: 200,
    kinds: ['event'],
    limit: 50,
    cursor: 7
  });
  assert.equal(parse(result).stats['/a'].count, 3);
});

test('stop reports how many entries remain readable', async () => {
  const handlers = register({ stop: () => ({ stopped: true, entries: 42 }) });
  assert.equal(parse(await handlers.get('lol_wamp_record_stop')({})).entries, 42);
});
