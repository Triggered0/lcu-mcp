import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/index.js';
import { ENDPOINTS } from '../src/tools/curated.js';
import { fakeContext } from './helpers/context.js';

async function connect() {
  const server = createServer(fakeContext());
  const client = new Client({ name: 'test', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);
  return client;
}

test('lol_endpoints lists the whole table by default', async () => {
  const client = await connect();
  const result = await client.callTool({ name: 'lol_endpoints', arguments: {} });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.total, ENDPOINTS.length);
  assert.equal(payload.matched, ENDPOINTS.length);
  assert.ok(payload.groups.includes('champ-select'));
  await client.close();
});

test('lol_endpoints filters', async () => {
  const client = await connect();
  const result = await client.callTool({ name: 'lol_endpoints', arguments: { filter: 'ready-check' } });
  const payload = JSON.parse(result.content[0].text);
  assert.ok(payload.matched >= 2);
  assert.ok(payload.matched < payload.total);
  assert.ok(payload.endpoints.every((e) => e.path.includes('ready-check')));
  await client.close();
});

test('a filter matching nothing returns an empty list, not an error', async () => {
  const client = await connect();
  const result = await client.callTool({ name: 'lol_endpoints', arguments: { filter: 'zzz-nope' } });
  assert.equal(result.isError, undefined);
  assert.equal(JSON.parse(result.content[0].text).matched, 0);
  await client.close();
});
