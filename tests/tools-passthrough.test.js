import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/index.js';
import { fakeContext } from './helpers/context.js';

async function connect(ctx) {
  const server = createServer(ctx);
  const client = new Client({ name: 'test', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);
  return client;
}

function recordingContext(overrides = {}) {
  const calls = [];
  const ctx = fakeContext({
    config: { ...fakeContext().config, writeAllowlist: ['POST /lol-matchmaking/v1/ready-check/accept'], ...overrides }
  });
  ctx.lcu = {
    ...ctx.lcu,
    request: async (method, path, body) => {
      calls.push({ method, path, body });
      return { status: 204, body: '' };
    },
    get: async (path) => {
      calls.push({ method: 'GET', path });
      return { status: 200, body: { phase: 'Lobby' } };
    }
  };
  return { ctx, calls };
}

test('lol_get returns status and body', async () => {
  const { ctx, calls } = recordingContext();
  const client = await connect(ctx);
  const result = await client.callTool({ name: 'lol_get', arguments: { path: '/lol-gameflow/v1/session' } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), { status: 200, body: { phase: 'Lobby' } });
  assert.deepEqual(calls, [{ method: 'GET', path: '/lol-gameflow/v1/session' }]);
  await client.close();
});

test('lol_get rejects a path without a leading slash', async () => {
  const { ctx, calls } = recordingContext();
  const client = await connect(ctx);
  const result = await client.callTool({ name: 'lol_get', arguments: { path: 'lol-gameflow/v1/session' } });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
  await client.close();
});

test('an allowlisted write reaches the client', async () => {
  const { ctx, calls } = recordingContext();
  const client = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_request',
    arguments: { method: 'POST', path: '/lol-matchmaking/v1/ready-check/accept' }
  });
  assert.equal(result.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  await client.close();
});

test('a denied write is refused without touching the client', async () => {
  const { ctx, calls } = recordingContext();
  const client = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_request',
    arguments: { method: 'POST', path: '/lol-lobby/v2/lobby', body: { queueId: 430 } }
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /"POST \/lol-lobby\/v2\/lobby"/);
  assert.match(result.content[0].text, /writeAllowlist/);
  assert.match(result.content[0].text, /config\/allowlist\.json/);
  assert.equal(calls.length, 0, 'the request must not be sent');
  await client.close();
});

test('GET through lol_request needs no allowlist entry', async () => {
  const { ctx, calls } = recordingContext();
  const client = await connect(ctx);
  const result = await client.callTool({ name: 'lol_request', arguments: { method: 'GET', path: '/anything' } });
  assert.equal(result.isError, undefined);
  assert.equal(calls.length, 1);
  await client.close();
});

test('an LCU failure comes back as a tool error', async () => {
  const { ctx } = recordingContext();
  ctx.lcu.get = async () => {
    throw new Error('League client is not running: no lockfile at C:\\Riot Games\\League of Legends\\lockfile');
  };
  const client = await connect(ctx);
  const result = await client.callTool({ name: 'lol_get', arguments: { path: '/lol-gameflow/v1/session' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not running/);
  await client.close();
});
