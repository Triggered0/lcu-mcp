import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/index.js';
import { RingBuffer } from '../src/lcu/buffer.js';
import { fakeContext } from './helpers/context.js';

function tapContext() {
  const buffer = new RingBuffer(100);
  const calls = { start: [], stop: 0 };
  let running = false;
  let filters = [];
  const ctx = fakeContext({ buffer });
  ctx.buffer = buffer;
  ctx.tap = {
    start: async (f = []) => {
      running = true;
      filters = f;
      calls.start.push(f);
    },
    stop: () => {
      running = false;
      calls.stop += 1;
    },
    statusSnapshot: () => ({ running, connected: running, filters, attempts: 0, buffered: buffer.length, lastError: null })
  };
  return { ctx, buffer, calls };
}

async function connect(ctx) {
  const server = createServer(ctx);
  const client = new Client({ name: 'test', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);
  return client;
}

test('lol_events_start passes filters to the tap', async () => {
  const { ctx, calls } = tapContext();
  const client = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_events_start',
    arguments: { filters: ['/lol-champ-select/', '/lol-gameflow/'] }
  });
  assert.deepEqual(JSON.parse(result.content[0].text).filters, ['/lol-champ-select/', '/lol-gameflow/']);
  assert.deepEqual(calls.start, [['/lol-champ-select/', '/lol-gameflow/']]);
  await client.close();
});

test('lol_events_start twice is not an error and replaces filters', async () => {
  const { ctx, calls } = tapContext();
  const client = await connect(ctx);
  await client.callTool({ name: 'lol_events_start', arguments: { filters: ['/a/'] } });
  const second = await client.callTool({ name: 'lol_events_start', arguments: { filters: ['/b/'] } });
  assert.equal(second.isError, undefined);
  assert.deepEqual(calls.start, [['/a/'], ['/b/']]);
  await client.close();
});

test('lol_events_poll drains with a cursor', async () => {
  const { ctx, buffer } = tapContext();
  const client = await connect(ctx);
  await client.callTool({ name: 'lol_events_start', arguments: {} });
  buffer.push({ eventType: 'Update', uri: '/lol-gameflow/v1/session', data: 1, truncated: false });
  buffer.push({ eventType: 'Update', uri: '/lol-champ-select/v1/session', data: 2, truncated: false });

  const first = JSON.parse((await client.callTool({ name: 'lol_events_poll', arguments: {} })).content[0].text);
  assert.equal(first.entries.length, 2);
  assert.equal(first.cursor, 2);
  assert.equal(first.dropped, 0);

  const second = JSON.parse(
    (await client.callTool({ name: 'lol_events_poll', arguments: { since: first.cursor } })).content[0].text
  );
  assert.equal(second.entries.length, 0);
  assert.equal(second.cursor, 2);
  await client.close();
});

test('lol_events_poll honours limit and filter', async () => {
  const { ctx, buffer } = tapContext();
  const client = await connect(ctx);
  for (let i = 0; i < 5; i += 1) buffer.push({ eventType: 'Update', uri: '/lol-gameflow/v1/session', data: i });
  buffer.push({ eventType: 'Update', uri: '/lol-champ-select/v1/session', data: 'cs' });

  const limited = JSON.parse((await client.callTool({ name: 'lol_events_poll', arguments: { limit: 2 } })).content[0].text);
  assert.equal(limited.entries.length, 2);
  assert.equal(limited.remaining, 4);

  const filtered = JSON.parse(
    (await client.callTool({ name: 'lol_events_poll', arguments: { filter: '/lol-champ-select/' } })).content[0].text
  );
  assert.equal(filtered.entries.length, 1);
  await client.close();
});

test('lol_events_poll reports dropped after the buffer wraps', async () => {
  const { ctx } = tapContext();
  ctx.buffer = new RingBuffer(3);
  const client = await connect(ctx);
  for (let i = 0; i < 10; i += 1) ctx.buffer.push({ eventType: 'Update', uri: '/x', data: i });
  const payload = JSON.parse((await client.callTool({ name: 'lol_events_poll', arguments: { since: 2 } })).content[0].text);
  assert.equal(payload.dropped, 5);
  await client.close();
});

test('lol_events_stop stops the tap and reports what is buffered', async () => {
  const { ctx, calls, buffer } = tapContext();
  const client = await connect(ctx);
  await client.callTool({ name: 'lol_events_start', arguments: {} });
  buffer.push({ eventType: 'Update', uri: '/x' });
  const payload = JSON.parse((await client.callTool({ name: 'lol_events_stop', arguments: {} })).content[0].text);
  assert.equal(payload.stopped, true);
  assert.equal(payload.buffered, 1);
  assert.equal(calls.stop, 1);
  await client.close();
});

test('limit above the cap is rejected by schema validation', async () => {
  const { ctx } = tapContext();
  const client = await connect(ctx);
  const result = await client.callTool({ name: 'lol_events_poll', arguments: { limit: 5000 } });
  assert.equal(result.isError, true);
  await client.close();
});
