import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerLaunchTool } from '../src/tools/launch.js';

function fakeLaunchContext(overrides = {}) {
  const spawned = [];
  const base = {
    config: { configPath: 'config/allowlist.json' },
    lcu: {
      credentials: async () => {
        throw new Error('League client is not running');
      },
      get: async () => ({ status: 200, body: {} })
    },
    fileExists: (path) => path.includes('RiotClientServices.exe'),
    spawner: (exe, args, opts) => {
      spawned.push({ exe, args, opts });
      return {
        pid: 12345,
        unref: () => {}
      };
    },
    pollIntervalMs: 10,
    cooldownMs: 10
  };

  return {
    ctx: {
      ...base,
      ...overrides,
      lcu: { ...base.lcu, ...overrides.lcu }
    },
    spawned
  };
}

async function connect(ctx) {
  const server = new McpServer({ name: 'test-launch', version: '1.0.0' });
  registerLaunchTool(server, ctx);
  const client = new Client({ name: 'test', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);
  return { client, server };
}

test('lol_launch_client returns alreadyRunning: true if client is already responsive', async () => {
  const { ctx, spawned } = fakeLaunchContext({
    lcu: {
      credentials: async () => ({ port: 29669, password: 'pw' }),
      get: async (path) => {
        if (path === '/riotclient/region-locale') return { status: 200, body: {} };
        return { status: 404 };
      }
    }
  });

  const { client } = await connect(ctx);
  const result = await client.callTool({ name: 'lol_launch_client', arguments: {} });
  assert.equal(result.isError, undefined);

  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.success, true);
  assert.equal(payload.alreadyRunning, true);
  assert.equal(spawned.length, 0);

  await client.close();
});

test('lol_launch_client returns error if executable not found', async () => {
  const { ctx, spawned } = fakeLaunchContext({
    fileExists: () => false
  });

  const { client } = await connect(ctx);
  const result = await client.callTool({ name: 'lol_launch_client', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not found/i);
  assert.equal(spawned.length, 0);

  await client.close();
});

test('lol_launch_client launches client with waitForReady: false', async () => {
  const { ctx, spawned } = fakeLaunchContext();
  const { client } = await connect(ctx);

  const result = await client.callTool({
    name: 'lol_launch_client',
    arguments: { waitForReady: false }
  });

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.success, true);
  assert.equal(payload.alreadyRunning, false);
  assert.equal(payload.pid, 12345);
  assert.equal(spawned.length, 1);
  assert.match(spawned[0].exe, /RiotClientServices\.exe/);
  assert.deepEqual(spawned[0].args, ['--launch-product=league_of_legends', '--launch-patchline=live']);

  await client.close();
});

test('lol_launch_client launches client and waits until LCU is ready', async () => {
  let attempts = 0;
  const { ctx, spawned } = fakeLaunchContext({
    lcu: {
      credentials: async () => {
        attempts++;
        if (attempts < 2) throw new Error('not running yet');
        return { port: 29669, password: 'pw' };
      },
      get: async (path) => {
        if (path === '/riotclient/region-locale' && attempts >= 2) {
          return { status: 200, body: {} };
        }
        return { status: 503 };
      }
    }
  });

  const { client } = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_launch_client',
    arguments: { waitForReady: true, timeoutSeconds: 5 }
  });

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.success, true);
  assert.equal(payload.alreadyRunning, false);
  assert.equal(payload.lcuReady, true);
  assert.equal(spawned.length, 1);

  await client.close();
});

test('lol_launch_client handles timeout when LCU does not become ready', async () => {
  const { ctx, spawned } = fakeLaunchContext({
    lcu: {
      credentials: async () => {
        throw new Error('still not running');
      }
    }
  });

  const { client } = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_launch_client',
    arguments: { waitForReady: true, timeoutSeconds: 1 }
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Timed out waiting for League client readiness/);
  assert.equal(spawned.length, 1);

  await client.close();
});
