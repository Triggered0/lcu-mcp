import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerStaticTools } from '../src/tools/static.js';
import { createServer } from '../src/index.js';
import { LcuStaticService } from '../src/lcu/static.js';
import { fakeContext } from './helpers/context.js';

async function connect(ctx) {
  const server = new McpServer({ name: 'test-static', version: '1.0.0' });
  registerStaticTools(server, ctx);
  const client = new Client({ name: 'test', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);
  return { client, server };
}

test('lol_static registers with all four annotation hints', async () => {
  const { client } = await connect(fakeContext());
  const tool = (await client.listTools()).tools.find((t) => t.name === 'lol_static');

  assert.ok(tool);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.equal(tool.annotations.idempotentHint, true);
  assert.equal(tool.annotations.openWorldHint, true);

  await client.close();
});

test('lol_static forwards arguments to the service', async () => {
  let received = null;
  const ctx = fakeContext({
    staticData: {
      query: async (args) => {
        received = args;
        return { kind: 'champions', total: 242, count: 1, truncated: false, entries: [], missing: [] };
      }
    }
  });

  const { client } = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_static',
    arguments: { kind: 'champions', ids: [157], fields: ['roles'], limit: 10, offset: 5, refresh: true }
  });

  assert.equal(result.isError, undefined);
  assert.equal(received.kind, 'champions');
  assert.deepEqual(received.ids, [157]);
  assert.deepEqual(received.fields, ['roles']);
  assert.equal(received.limit, 10);
  assert.equal(received.offset, 5);
  assert.equal(received.refresh, true);

  await client.close();
});

test('lol_static rejects an unknown kind before reaching the service', async () => {
  const ctx = fakeContext({
    staticData: {
      query: async () => assert.fail('service must not be called for an invalid kind')
    }
  });

  const { client } = await connect(ctx);
  const result = await client.callTool({ name: 'lol_static', arguments: { kind: 'runes' } });

  assert.equal(result.isError, true);
  await client.close();
});

test('lol_static rejects a limit above the cap', async () => {
  const { client } = await connect(fakeContext());
  const result = await client.callTool({
    name: 'lol_static',
    arguments: { kind: 'items', limit: 5000 }
  });

  assert.equal(result.isError, true);
  await client.close();
});

test('lol_static returns service errors through guard', async () => {
  const ctx = fakeContext({
    staticData: {
      query: async () => {
        throw new Error('LCU request GET /lol-game-data/assets/v1/items.json failed: HTTP 503');
      }
    }
  });

  const { client } = await connect(ctx);
  const result = await client.callTool({ name: 'lol_static', arguments: { kind: 'items' } });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /HTTP 503/);

  await client.close();
});

test('createServer registers lol_static', async () => {
  const server = createServer(fakeContext());
  const client = new Client({ name: 'test', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);

  const tools = (await client.listTools()).tools;
  assert.ok(tools.find((t) => t.name === 'lol_static'), 'lol_static should be registered in createServer');

  await client.close();
});

test('end-to-end through a real LcuStaticService', async () => {
  const ctx = fakeContext({
    staticData: new LcuStaticService({
      client: {
        get: async () => ({
          status: 200,
          body: [
            { id: 157, name: 'Yasuo', roles: ['fighter'] },
            { id: 1, name: 'Annie', roles: ['mage'] }
          ]
        })
      }
    })
  });

  const { client } = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_static',
    arguments: { kind: 'champions', ids: [157, 404] }
  });

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0].text);
  assert.deepEqual(payload.entries, [{ id: 157, name: 'Yasuo' }]);
  assert.deepEqual(payload.missing, [404]);
  assert.equal(payload.total, 2);

  await client.close();
});
