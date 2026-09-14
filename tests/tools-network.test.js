import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerNetworkTools } from '../src/tools/network.js';
import { createServer } from '../src/index.js';
import { fakeContext } from './helpers/context.js';

const TOOLS = [
  'lol_cdp_network_start',
  'lol_cdp_network_tail',
  'lol_cdp_network_body',
  'lol_cdp_network_summary',
  'lol_cdp_network_stop'
];

async function connect(ctx) {
  const server = new McpServer({ name: 'test-network', version: '1.0.0' });
  registerNetworkTools(server, ctx);
  const client = new Client({ name: 'test', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);
  return { client, server };
}

test('every network tool declares all four annotation hints', async () => {
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

test('tail reaches the renderer only through body, and the hints say so', async () => {
  const { client } = await connect(fakeContext());
  const tools = (await client.listTools()).tools;

  assert.equal(tools.find((t) => t.name === 'lol_cdp_network_tail').annotations.openWorldHint, false);
  assert.equal(tools.find((t) => t.name === 'lol_cdp_network_summary').annotations.openWorldHint, false);
  assert.equal(tools.find((t) => t.name === 'lol_cdp_network_body').annotations.openWorldHint, true);
  await client.close();
});

test('lol_cdp_network_tail forwards its arguments', async () => {
  let received = null;
  const ctx = fakeContext({
    networkTailer: {
      tail: (args) => {
        received = args;
        return { entries: [], cursor: 0, dropped: 0, remaining: 0, inflight: [] };
      }
    }
  });

  const { client } = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_cdp_network_tail',
    arguments: { cursor: 7, limit: 5, urlContains: 'lol-x', method: 'POST', minStatus: 400, failedOnly: true }
  });

  assert.equal(result.isError, undefined);
  assert.equal(received.cursor, 7);
  assert.equal(received.limit, 5);
  assert.equal(received.urlContains, 'lol-x');
  assert.equal(received.method, 'POST');
  assert.equal(received.minStatus, 400);
  assert.equal(received.failedOnly, true);
  await client.close();
});

test('lol_cdp_network_body forwards the requestId', async () => {
  let received = null;
  const ctx = fakeContext({
    networkTailer: {
      body: async (requestId) => {
        received = requestId;
        return { requestId, url: 'u', status: 200, base64Encoded: false, body: '{}' };
      }
    }
  });

  const { client } = await connect(ctx);
  const result = await client.callTool({ name: 'lol_cdp_network_body', arguments: { requestId: 'abc' } });

  assert.equal(result.isError, undefined);
  assert.equal(received, 'abc');
  await client.close();
});

test('lol_cdp_network_body requires a requestId', async () => {
  const { client } = await connect(fakeContext());
  const result = await client.callTool({ name: 'lol_cdp_network_body', arguments: {} });

  assert.equal(result.isError, true);
  await client.close();
});

test('lol_cdp_network_start invokes ctx.networkTailer.start() and returns its result', async () => {
  let called = false;
  const ctx = fakeContext({
    networkTailer: {
      start: async () => {
        called = true;
        return { startedAt: 12345, targetId: 'T1', alreadyRunning: false };
      }
    }
  });

  const { client } = await connect(ctx);
  const result = await client.callTool({ name: 'lol_cdp_network_start', arguments: {} });

  assert.equal(result.isError, undefined);
  assert.equal(called, true);
  const payload = JSON.parse(result.content[0].text);
  assert.deepEqual(payload, { startedAt: 12345, targetId: 'T1', alreadyRunning: false });
  await client.close();
});

test('lol_cdp_network_summary forwards arguments and returns its result', async () => {
  let received = null;
  const ctx = fakeContext({
    networkTailer: {
      summary: (args) => {
        received = args;
        return { total: 1, groups: [{ method: 'GET', url: 'https://127.0.0.1:1/lol-x', count: 1 }] };
      }
    }
  });

  const { client } = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_cdp_network_summary',
    arguments: { since: 1000, until: 2000, urlContains: 'lol-x', method: 'GET' }
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(received, { since: 1000, until: 2000, urlContains: 'lol-x', method: 'GET' });
  const payload = JSON.parse(result.content[0].text);
  assert.deepEqual(payload, { total: 1, groups: [{ method: 'GET', url: 'https://127.0.0.1:1/lol-x', count: 1 }] });
  await client.close();
});

test('lol_cdp_network_stop invokes ctx.networkTailer.stop() and returns its result', async () => {
  let called = false;
  const ctx = fakeContext({
    networkTailer: {
      stop: () => {
        called = true;
        return { stopped: true, entries: 15 };
      }
    }
  });

  const { client } = await connect(ctx);
  const result = await client.callTool({ name: 'lol_cdp_network_stop', arguments: {} });

  assert.equal(result.isError, undefined);
  assert.equal(called, true);
  const payload = JSON.parse(result.content[0].text);
  assert.deepEqual(payload, { stopped: true, entries: 15 });
  await client.close();
});

test('a tailer error comes back through the guard', async () => {
  const ctx = fakeContext({
    networkTailer: {
      tail: () => {
        throw new Error('The network tailer is not running');
      }
    }
  });

  const { client } = await connect(ctx);
  const result = await client.callTool({ name: 'lol_cdp_network_tail', arguments: {} });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not running/);
  await client.close();
});

test('createServer registers every network tool', async () => {
  const server = createServer(fakeContext());
  const client = new Client({ name: 'test', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);

  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const name of TOOLS) assert.ok(names.includes(name), `${name} should be registered in createServer`);

  await client.close();
});
