import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, buildContext } from '../src/index.js';
import { fail, guard, ok } from '../src/tools/result.js';
import { fakeContext } from './helpers/context.js';
import { clearPortCache } from '../src/cdp/discover.js';

async function connect(ctx) {
  const server = createServer(ctx);
  const client = new Client({ name: 'test', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);
  return { client, server };
}

test('ok and fail produce MCP content shapes', () => {
  assert.deepEqual(ok({ a: 1 }), { content: [{ type: 'text', text: '{\n  "a": 1\n}' }] });
  assert.equal(fail('nope').isError, true);
});

test('guard redacts secrets out of thrown messages', async () => {
  const ctx = fakeContext();
  const handler = guard(async () => {
    throw new Error('connect wss://riot:S3cr3t-Pa55@127.0.0.1:1 failed');
  }, ctx);
  const result = await handler({});
  assert.equal(result.isError, true);
  assert.ok(!result.content[0].text.includes('S3cr3t-Pa55'));
  assert.ok(result.content[0].text.includes('***'));
});

test('the server registers exactly the tools wired so far', async () => {
  const { client } = await connect(fakeContext());
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'lol_cdp_console_start',
    'lol_cdp_console_stop',
    'lol_cdp_console_tail',
    'lol_cdp_screenshot',
    'lol_cdp_targets',
    'lol_dom_query',
    'lol_endpoints',
    'lol_eval',
    'lol_events_poll',
    'lol_events_start',
    'lol_events_stop',
    'lol_forensics_correlate',
    'lol_get',
    'lol_request',
    'lol_restart_ux',
    'lol_schema',
    'lol_status',
    'lol_wamp_record_dump',
    'lol_wamp_record_start',
    'lol_wamp_record_stop'
  ]);
  await client.close();
});

test('lol_status reports both subsystems and the config', async () => {
  const { client } = await connect(fakeContext());
  const result = await client.callTool({ name: 'lol_status', arguments: {} });
  const status = JSON.parse(result.content[0].text);
  assert.equal(status.lcu.port, 29669);
  assert.equal(status.cdp.attached, false);
  assert.equal(status.cdp.port, 8888);
  assert.equal(status.events.running, false);
  assert.equal(status.config.allowEval, true);
  assert.equal(status.config.cdpPort, 8888);
  await client.close();
});

test('lol_status never leaks the password', async () => {
  const { client } = await connect(fakeContext());
  const result = await client.callTool({ name: 'lol_status', arguments: {} });
  assert.ok(!JSON.stringify(result).includes('S3cr3t-Pa55'));
  await client.close();
});

test('the server can invoke lol_restart_ux with fakeContext', async () => {
  const { client } = await connect(fakeContext());
  const result = await client.callTool({ name: 'lol_restart_ux', arguments: { waitForReady: false } });
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.restarted, true);
  await client.close();
});

test('buildContext wires dynamic portResolver to cdp and consoleCdp', async () => {
  clearPortCache();
  const ctx = buildContext({
    env: {
      LCU_CDP_PORT: '9876',
      LCU_MCP_CONFIG: 'does-not-exist-for-test.json'
    }
  });
  assert.equal(await ctx.cdp.getPort(), 9876);
  assert.equal(ctx.cdp.port, 9876);
});

