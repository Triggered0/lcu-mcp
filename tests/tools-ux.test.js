import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerUxTools } from '../src/tools/ux.js';

function fakeUxContext(overrides = {}) {
  const calls = {
    lcuRequests: [],
    lcuGets: [],
    cdpClose: 0,
    consoleTailerStop: 0,
    portResolutions: 0,
    discoverPageCalls: []
  };

  const base = {
    lcu: {
      request: async (method, path, body) => {
        calls.lcuRequests.push({ method, path, body });
        if (path === '/riotclient/kill-and-restart-ux') {
          return { status: 204 };
        }
        return { status: 200, body: {} };
      },
      get: async (path) => {
        calls.lcuGets.push(path);
        return { status: 200, body: { region: 'TR' } };
      }
    },
    cdp: {
      close: () => {
        calls.cdpClose += 1;
      }
    },
    consoleTailer: {
      stop: () => {
        calls.consoleTailerStop += 1;
      }
    },
    discoverPage: async (port) => {
      calls.discoverPageCalls.push(port);
      return { id: 'P1', title: 'League of Legends' };
    },
    resolvePort: async () => {
      calls.portResolutions += 1;
      return { port: 8888, source: 'pengu-config' };
    },
    secrets: () => [],
    cooldownMs: 10,
    pollIntervalMs: 10
  };

  const ctx = {
    ...base,
    ...overrides,
    lcu: overrides.lcu ?? base.lcu,
    cdp: 'cdp' in overrides ? overrides.cdp : base.cdp,
    consoleTailer: 'consoleTailer' in overrides ? overrides.consoleTailer : base.consoleTailer
  };

  return { ctx, calls };
}

async function createUxServer(ctx) {
  const server = new McpServer({ name: 'test-ux', version: '0.1.0' });
  registerUxTools(server, ctx);
  const client = new Client({ name: 'test-client', version: '1.0' });
  const [cTransport, sTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(cTransport), server.server.connect(sTransport)]);
  return { client, server };
}

test('lol_restart_ux with waitForReady=false dispatches and returns immediately', async () => {
  const { ctx, calls } = fakeUxContext();
  const { client } = await createUxServer(ctx);

  const result = await client.callTool({
    name: 'lol_restart_ux',
    arguments: { waitForReady: false }
  });

  assert.equal(result.isError, undefined);
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.success, true);
  assert.equal(data.restarted, true);
  assert.equal(data.waiting, false);
  assert.equal(data.message, 'Restart command sent to Riot Client UX');

  assert.equal(calls.cdpClose, 1);
  assert.equal(calls.consoleTailerStop, 1);
  assert.equal(calls.lcuRequests.length, 1);
  assert.equal(calls.lcuRequests[0].method, 'POST');
  assert.equal(calls.lcuRequests[0].path, '/riotclient/kill-and-restart-ux');
  assert.equal(calls.lcuGets.length, 0);

  await client.close();
});

test('lol_restart_ux with waitForReady=true polls and returns success', async () => {
  const { ctx, calls } = fakeUxContext();
  const { client } = await createUxServer(ctx);

  const result = await client.callTool({
    name: 'lol_restart_ux',
    arguments: { waitForReady: true, timeoutSeconds: 5 }
  });

  assert.equal(result.isError, undefined);
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.success, true);
  assert.equal(data.lcuReady, true);
  assert.equal(data.cdpReady, true);
  assert.equal(data.cdpPort, 8888);
  assert.equal(data.targetTitle, 'League of Legends');
  assert.equal(data.message, 'League Client UX restarted and fully responsive');
  assert.equal(typeof data.durationMs, 'number');

  assert.equal(calls.cdpClose, 1);
  assert.equal(calls.consoleTailerStop, 1);
  assert.equal(calls.lcuRequests.length, 1);
  assert.ok(calls.lcuGets.length >= 1);
  assert.equal(calls.discoverPageCalls[0], 8888);

  await client.close();
});

test('lol_restart_ux handles ECONNRESET on kill endpoint cleanly', async () => {
  const { ctx, calls } = fakeUxContext({
    lcu: {
      request: async () => {
        const err = new Error('read ECONNRESET');
        err.code = 'ECONNRESET';
        throw err;
      },
      get: async () => ({ status: 200, body: {} })
    }
  });
  const { client } = await createUxServer(ctx);

  const result = await client.callTool({
    name: 'lol_restart_ux',
    arguments: { waitForReady: false }
  });

  assert.equal(result.isError, undefined);
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.restarted, true);
  assert.equal(data.waiting, false);

  await client.close();
});

test('lol_restart_ux handles socket hang up and UND_ERR_SOCKET cleanly', async () => {
  const { ctx } = fakeUxContext({
    lcu: {
      request: async () => {
        const err = new Error('socket hang up');
        err.code = 'UND_ERR_SOCKET';
        throw err;
      },
      get: async () => ({ status: 200, body: {} })
    }
  });
  const { client } = await createUxServer(ctx);

  const result = await client.callTool({
    name: 'lol_restart_ux',
    arguments: { waitForReady: false }
  });

  assert.equal(result.isError, undefined);
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.restarted, true);

  await client.close();
});

test('lol_restart_ux rethrows unexpected errors on kill endpoint', async () => {
  const { ctx } = fakeUxContext({
    lcu: {
      request: async () => {
        throw new Error('HTTP 403 Forbidden: UX restart blocked');
      },
      get: async () => ({ status: 200, body: {} })
    }
  });
  const { client } = await createUxServer(ctx);

  const result = await client.callTool({
    name: 'lol_restart_ux',
    arguments: { waitForReady: false }
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /HTTP 403 Forbidden/);

  await client.close();
});

test('lol_restart_ux times out when LCU never becomes ready', async () => {
  const { ctx } = fakeUxContext({
    lcu: {
      request: async () => ({ status: 204 }),
      get: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:2999');
      }
    },
    cooldownMs: 5,
    pollIntervalMs: 5
  });
  const { client } = await createUxServer(ctx);

  const result = await client.callTool({
    name: 'lol_restart_ux',
    arguments: { waitForReady: true, timeoutSeconds: 2 }
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Timed out waiting for UX readiness after 2s/);
  assert.match(result.content[0].text, /LCU API ready: false/);
  assert.match(result.content[0].text, /CDP target ready: false \(port null\)/);

  await client.close();
});

test('lol_restart_ux times out when CDP target is never found', async () => {
  const { ctx } = fakeUxContext({
    discoverPage: async () => {
      throw new Error('CDP on port 8888 has no page target');
    },
    cooldownMs: 5,
    pollIntervalMs: 5
  });
  const { client } = await createUxServer(ctx);

  const result = await client.callTool({
    name: 'lol_restart_ux',
    arguments: { waitForReady: true, timeoutSeconds: 2 }
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Timed out waiting for UX readiness after 2s/);
  assert.match(result.content[0].text, /LCU API ready: true/);
  assert.match(result.content[0].text, /CDP target ready: false \(port 8888\)/);

  await client.close();
});

test('lol_restart_ux handles intermittent LCU and CDP readiness before timeout', async () => {
  let lcuAttempts = 0;
  let cdpAttempts = 0;

  const { ctx } = fakeUxContext({
    lcu: {
      request: async () => ({ status: 204 }),
      get: async () => {
        lcuAttempts += 1;
        if (lcuAttempts < 3) {
          throw new Error('LCU initializing');
        }
        return { status: 200, body: {} };
      }
    },
    discoverPage: async () => {
      cdpAttempts += 1;
      if (cdpAttempts < 2) {
        throw new Error('Waiting for page target');
      }
      return { id: 'P1', title: 'League of Legends' };
    },
    cooldownMs: 5,
    pollIntervalMs: 5
  });
  const { client } = await createUxServer(ctx);

  const result = await client.callTool({
    name: 'lol_restart_ux',
    arguments: { waitForReady: true, timeoutSeconds: 5 }
  });

  assert.equal(result.isError, undefined);
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.success, true);
  assert.equal(data.lcuReady, true);
  assert.equal(data.cdpReady, true);
  assert.ok(lcuAttempts >= 3);
  assert.ok(cdpAttempts >= 2);

  await client.close();
});

test('lol_restart_ux gracefully handles undefined cdp and consoleTailer in ctx', async () => {
  const { ctx } = fakeUxContext({
    cdp: undefined,
    consoleTailer: undefined
  });
  const { client } = await createUxServer(ctx);

  const result = await client.callTool({
    name: 'lol_restart_ux',
    arguments: { waitForReady: false }
  });

  assert.equal(result.isError, undefined);
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.success, true);
  assert.equal(data.restarted, true);

  await client.close();
});

test('lol_restart_ux validates input schema constraints', async () => {
  const { ctx } = fakeUxContext();
  const { client } = await createUxServer(ctx);

  const result = await client.callTool({
    name: 'lol_restart_ux',
    arguments: { timeoutSeconds: 1 } // min is 2
  });

  assert.equal(result.isError, true);

  await client.close();
});
