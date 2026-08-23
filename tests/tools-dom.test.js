import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/index.js';
import { CdpUnavailableError } from '../src/cdp/discover.js';
import { fakeContext } from './helpers/context.js';

function cdpContext({ allowEval = true } = {}) {
  const calls = [];
  const base = fakeContext();
  const ctx = fakeContext({ config: { ...base.config, allowEval } });
  ctx.cdp = {
    statusSnapshot: base.cdp.statusSnapshot,
    domQuery: async (selector, options) => {
      calls.push({ kind: 'domQuery', selector, options });
      return [{ tag: 'BUTTON', text: 'Accept' }];
    },
    evaluate: async (expression, options) => {
      calls.push({ kind: 'evaluate', expression, options });
      return { phase: 'ReadyCheck' };
    }
  };
  return { ctx, calls };
}

async function connect(ctx) {
  const server = createServer(ctx);
  const client = new Client({ name: 'test', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);
  return client;
}

test('lol_dom_query forwards selector, all, and props', async () => {
  const { ctx, calls } = cdpContext();
  const client = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_dom_query',
    arguments: { selector: '.lol-uikit-flat-button', all: true, props: ['disabled'] }
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls[0], {
    kind: 'domQuery',
    selector: '.lol-uikit-flat-button',
    options: { all: true, props: ['disabled'] }
  });
  await client.close();
});

test('lol_dom_query works with allowEval off', async () => {
  const { ctx } = cdpContext({ allowEval: false });
  const client = await connect(ctx);
  const result = await client.callTool({ name: 'lol_dom_query', arguments: { selector: 'body' } });
  assert.equal(result.isError, undefined);
  await client.close();
});

test('lol_eval evaluates and returns the value', async () => {
  const { ctx, calls } = cdpContext();
  const client = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_eval',
    arguments: { expression: "fetch('/lol-gameflow/v1/session').then(r => r.json())", awaitPromise: true }
  });
  assert.deepEqual(JSON.parse(result.content[0].text), { value: { phase: 'ReadyCheck' } });
  assert.equal(calls[0].options.awaitPromise, true);
  await client.close();
});

test('lol_eval is refused when allowEval is false', async () => {
  const { ctx, calls } = cdpContext({ allowEval: false });
  const client = await connect(ctx);
  const result = await client.callTool({ name: 'lol_eval', arguments: { expression: '1 + 1' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /allowEval/);
  assert.equal(calls.length, 0, 'nothing is evaluated');
  await client.close();
});

test('a CDP outage surfaces the Pengu fix, not a socket error', async () => {
  const { ctx } = cdpContext();
  ctx.cdp.domQuery = async () => {
    throw new CdpUnavailableError(8888, 'ECONNREFUSED');
  };
  const client = await connect(ctx);
  const result = await client.callTool({ name: 'lol_dom_query', arguments: { selector: 'body' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /RemoteDebuggingPort/);
  await client.close();
});
