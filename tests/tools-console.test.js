import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerConsoleTools } from '../src/tools/console.js';

function register(tailer) {
  const handlers = new Map();
  const server = { registerTool: (name, _meta, handler) => handlers.set(name, handler) };
  registerConsoleTools(server, { consoleTailer: tailer, secrets: () => [] });
  return handlers;
}

const parse = (result) => JSON.parse(result.content[0].text);

test('start reports the attached target', async () => {
  const handlers = register({ start: async () => ({ startedAt: 1, targetId: 'PAGE-1' }) });
  assert.equal(parse(await handlers.get('lol_cdp_console_start')({})).targetId, 'PAGE-1');
});

test('tail forwards every filter', async () => {
  const calls = [];
  const handlers = register({
    tail: (options) => {
      calls.push(options);
      return { entries: [], cursor: 0, dropped: 0, remaining: 0, running: true, attached: true, targetId: 'P', startedAt: 1 };
    }
  });
  await handlers.get('lol_cdp_console_tail')({
    since: 10, until: 20, cursor: 3, limit: 25, level: 'error', targetId: 'P', text: 'socket'
  });
  assert.deepEqual(calls[0], {
    since: 10, until: 20, cursor: 3, limit: 25, level: 'error', targetId: 'P', text: 'socket'
  });
});

test('tailing a stopped tailer is a tool error, not an empty success', async () => {
  const handlers = register({
    tail: () => {
      throw new Error('The console tailer is not running, so there is nothing to tail.');
    }
  });
  const result = await handlers.get('lol_cdp_console_tail')({});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not running/);
});

test('stop reports how many entries were held', async () => {
  const handlers = register({ stop: () => ({ stopped: true, entries: 9 }) });
  assert.equal(parse(await handlers.get('lol_cdp_console_stop')({})).entries, 9);
});
