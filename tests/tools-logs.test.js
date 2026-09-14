import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerLogTools } from '../src/tools/logs.js';
import { createServer } from '../src/index.js';
import { fakeContext } from './helpers/context.js';

const TOOLS = [
  'lol_logs_tail',
  'lol_logs_watch_start',
  'lol_logs_watch_poll',
  'lol_logs_watch_stop',
  'lol_logs_sessions'
];

async function connect(ctx) {
  const server = new McpServer({ name: 'test-logs', version: '1.0.0' });
  registerLogTools(server, ctx);
  const client = new Client({ name: 'test', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);
  return { client, server };
}

test('every log tool declares all four annotation hints as booleans', async () => {
  const { client } = await connect(fakeContext());
  const tools = (await client.listTools()).tools;

  for (const name of TOOLS) {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `${name} should be registered`);
    for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
      assert.equal(typeof tool.annotations?.[hint], 'boolean', `${name} is missing a boolean ${hint}`);
    }
  }
  await client.close();
});

test('the declared annotation hints match the specification', async () => {
  const { client } = await connect(fakeContext());
  const tools = (await client.listTools()).tools;

  const expected = {
    lol_logs_tail: [true, false, true, true],
    lol_logs_watch_start: [false, false, true, true],
    lol_logs_watch_poll: [true, false, true, false],
    lol_logs_watch_stop: [false, true, true, true],
    lol_logs_sessions: [true, false, true, true]
  };

  for (const [name, hints] of Object.entries(expected)) {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `${name} should exist`);
    assert.deepEqual(
      [
        tool.annotations.readOnlyHint,
        tool.annotations.destructiveHint,
        tool.annotations.idempotentHint,
        tool.annotations.openWorldHint
      ],
      hints,
      `Mismatched hints for ${name}`
    );
  }
  await client.close();
});

test('lol_logs_tail forwards its arguments and applies defaults', async () => {
  let received = null;
  const ctx = fakeContext({
    logReader: {
      tail: async (args) => {
        received = args;
        return { target: args.target, filePath: 'test.log', totalSize: 100, returned: 1, entries: [{ level: 'INFO' }] };
      }
    }
  });

  const { client } = await connect(ctx);

  // Defaults test
  const res1 = await client.callTool({ name: 'lol_logs_tail', arguments: {} });
  assert.equal(res1.isError, undefined);
  assert.deepEqual(received, {
    target: 'client',
    lines: 100,
    level: 'ALL',
    search: null,
    session: null
  });

  // Explicit arguments test
  const res2 = await client.callTool({
    name: 'lol_logs_tail',
    arguments: {
      target: 'ux',
      lines: 25,
      level: 'ERROR',
      search: 'crash',
      session: 'old.log'
    }
  });
  assert.equal(res2.isError, undefined);
  assert.deepEqual(received, {
    target: 'ux',
    lines: 25,
    level: 'ERROR',
    search: 'crash',
    session: 'old.log'
  });

  const parsed = JSON.parse(res2.content[0].text);
  assert.equal(parsed.target, 'ux');
  assert.equal(parsed.returned, 1);

  await client.close();
});

test('lol_logs_tail rejects invalid target, lines out of range, or invalid level', async () => {
  const { client } = await connect(fakeContext());

  const badTarget = await client.callTool({ name: 'lol_logs_tail', arguments: { target: 'invalid' } });
  assert.equal(badTarget.isError, true);

  const zeroLines = await client.callTool({ name: 'lol_logs_tail', arguments: { lines: 0 } });
  assert.equal(zeroLines.isError, true);

  const tooManyLines = await client.callTool({ name: 'lol_logs_tail', arguments: { lines: 2001 } });
  assert.equal(tooManyLines.isError, true);

  const badLevel = await client.callTool({ name: 'lol_logs_tail', arguments: { level: 'VERBOSE' } });
  assert.equal(badLevel.isError, true);

  await client.close();
});

test('lol_logs_watch_start forwards target argument and applies default', async () => {
  let received = null;
  const ctx = fakeContext({
    logWatcher: {
      start: async (args) => {
        received = args;
        return { alreadyRunning: false, target: args.target, filePath: 'test.log', offset: 1234 };
      }
    }
  });

  const { client } = await connect(ctx);

  const res1 = await client.callTool({ name: 'lol_logs_watch_start', arguments: {} });
  assert.equal(res1.isError, undefined);
  assert.deepEqual(received, { target: 'client' });

  const res2 = await client.callTool({ name: 'lol_logs_watch_start', arguments: { target: 'game' } });
  assert.equal(res2.isError, undefined);
  assert.deepEqual(received, { target: 'game' });

  const parsed = JSON.parse(res2.content[0].text);
  assert.deepEqual(parsed, { alreadyRunning: false, target: 'game', filePath: 'test.log', offset: 1234 });

  await client.close();
});

test('lol_logs_watch_poll forwards its arguments and applies defaults', async () => {
  let received = null;
  const ctx = fakeContext({
    logWatcher: {
      poll: (args) => {
        received = args;
        return { entries: [{ level: 'WARN' }], cursor: 5, dropped: 0, remaining: 0, running: true, target: 'client', filePath: 'test.log' };
      }
    }
  });

  const { client } = await connect(ctx);

  const res1 = await client.callTool({ name: 'lol_logs_watch_poll', arguments: {} });
  assert.equal(res1.isError, undefined);
  assert.deepEqual(received, { cursor: 0, limit: 100, level: null, search: null });

  const res2 = await client.callTool({
    name: 'lol_logs_watch_poll',
    arguments: { cursor: 12, limit: 50, level: 'WARN', search: 'asset' }
  });
  assert.equal(res2.isError, undefined);
  assert.deepEqual(received, { cursor: 12, limit: 50, level: 'WARN', search: 'asset' });

  const parsed = JSON.parse(res2.content[0].text);
  assert.equal(parsed.cursor, 5);
  assert.equal(parsed.entries.length, 1);

  await client.close();
});

test('lol_logs_watch_stop invokes stop on logWatcher', async () => {
  let called = false;
  const ctx = fakeContext({
    logWatcher: {
      stop: async () => {
        called = true;
        return { stopped: true, entriesDiscarded: 42 };
      }
    }
  });

  const { client } = await connect(ctx);
  const result = await client.callTool({ name: 'lol_logs_watch_stop', arguments: {} });
  assert.equal(result.isError, undefined);
  assert.equal(called, true);
  const parsed = JSON.parse(result.content[0].text);
  assert.deepEqual(parsed, { stopped: true, entriesDiscarded: 42 });

  await client.close();
});

test('lol_logs_sessions forwards target and limit arguments', async () => {
  let received = null;
  const ctx = fakeContext({
    logFinder: {
      findSessions: async (target, limit) => {
        received = { target, limit };
        return [{ filename: 'session1.log', size: 1000, mtime: 12345 }];
      }
    }
  });

  const { client } = await connect(ctx);

  const res1 = await client.callTool({ name: 'lol_logs_sessions', arguments: {} });
  assert.equal(res1.isError, undefined);
  assert.deepEqual(received, { target: 'client', limit: 10 });

  const res2 = await client.callTool({ name: 'lol_logs_sessions', arguments: { target: 'game', limit: 25 } });
  assert.equal(res2.isError, undefined);
  assert.deepEqual(received, { target: 'game', limit: 25 });

  const parsed = JSON.parse(res2.content[0].text);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].filename, 'session1.log');

  await client.close();
});

test('errors in log tools propagate cleanly through guard', async () => {
  const ctx = fakeContext({
    logWatcher: {
      poll: () => {
        throw new Error('Log watcher is not running. Call lol_logs_watch_start first.');
      }
    },
    logReader: {
      tail: async () => {
        throw new Error('No log files found for target "client" with secret S3cr3t-Pa55');
      }
    }
  });

  const { client } = await connect(ctx);

  const pollRes = await client.callTool({ name: 'lol_logs_watch_poll', arguments: {} });
  assert.equal(pollRes.isError, true);
  assert.match(pollRes.content[0].text, /Log watcher is not running/);

  const tailRes = await client.callTool({ name: 'lol_logs_tail', arguments: {} });
  assert.equal(tailRes.isError, true);
  assert.match(tailRes.content[0].text, /No log files found/);
  // Redacts secrets
  assert.ok(!tailRes.content[0].text.includes('S3cr3t-Pa55'));
  assert.ok(tailRes.content[0].text.includes('***'));

  await client.close();
});

test('createServer registers every log tool', async () => {
  const server = createServer(fakeContext());
  const client = new Client({ name: 'test', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);

  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const name of TOOLS) {
    assert.ok(names.includes(name), `${name} should be registered in createServer`);
  }

  await client.close();
});

