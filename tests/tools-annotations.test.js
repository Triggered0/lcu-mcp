import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/index.js';
import { fakeContext } from './helpers/context.js';

const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];

// [readOnlyHint, destructiveHint, idempotentHint, openWorldHint]
const EXPECTED = {
  lol_status: [true, false, true, false],
  lol_get: [true, false, true, true],
  lol_request: [false, true, false, true],
  lol_endpoints: [true, false, true, false],
  lol_schema: [true, false, true, true],
  lol_static: [true, false, true, true],
  lol_events_start: [false, false, true, true],
  lol_events_poll: [true, false, true, false],
  lol_events_stop: [false, false, true, true],
  lol_dom_query: [true, false, true, true],
  lol_eval: [false, true, false, true],
  lol_wamp_record_start: [false, true, false, true],
  lol_wamp_record_dump: [true, false, true, false],
  lol_wamp_record_stop: [false, false, true, true],
  lol_cdp_console_start: [false, false, true, true],
  lol_cdp_console_tail: [true, false, true, false],
  lol_cdp_console_stop: [false, true, true, true],
  lol_cdp_network_start: [false, false, true, true],
  lol_cdp_network_tail: [true, false, true, false],
  lol_cdp_network_body: [true, false, true, true],
  lol_cdp_network_summary: [true, false, true, false],
  lol_cdp_network_stop: [false, true, true, true],
  lol_restart_ux: [false, true, false, true],
  lol_cdp_targets: [true, false, true, true],
  lol_cdp_screenshot: [false, true, false, true],
  lol_forensics_correlate: [true, false, true, false]
};

async function listTools() {
  const server = createServer(fakeContext());
  const client = new Client({ name: 'test', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

test('every tool declares all four annotation hints as booleans', async () => {
  for (const tool of await listTools()) {
    for (const hint of HINTS) {
      assert.equal(
        typeof tool.annotations?.[hint],
        'boolean',
        `${tool.name} is missing a boolean ${hint}`
      );
    }
  }
});

test('the declared hints match what each handler actually does', async () => {
  const actual = Object.fromEntries(
    (await listTools()).map((tool) => [tool.name, HINTS.map((hint) => tool.annotations[hint])])
  );
  assert.deepEqual(actual, EXPECTED);
});
