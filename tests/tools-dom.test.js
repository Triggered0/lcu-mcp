import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/index.js';
import { CdpUnavailableError } from '../src/cdp/discover.js';
import { fakeContext } from './helpers/context.js';
import { registerDomTools } from '../src/tools/dom.js';

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
      return { value: { phase: 'ReadyCheck' }, exceptionDetails: null };
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
  assert.deepEqual(JSON.parse(result.content[0].text), { value: { phase: 'ReadyCheck' }, exceptionDetails: null });
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

test('lol_eval returns a page exception as data rather than a tool error', async () => {
  // Wire the same fake cdp this file already uses, with evaluate resolving to
  // an exceptionDetails payload.
  const ctx = {
    config: { allowEval: true, configPath: 'config/allowlist.json' },
    cdp: {
      evaluate: async () => ({
        value: undefined,
        exceptionDetails: { description: 'TypeError: socket is null', lineNumber: 12, stackTrace: [] }
      })
    },
    secrets: () => []
  };
  const handlers = new Map();
  registerDomTools({ registerTool: (name, _meta, handler) => handlers.set(name, handler) }, ctx);
  const result = await handlers.get('lol_eval')({ expression: 'probe.socket.readyState' });
  assert.notEqual(result.isError, true, 'a page exception is data, not a tool failure');
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.exceptionDetails.description, 'TypeError: socket is null');
});

test('a password in a page exception never reaches the tool result', async () => {
  const ctx = {
    config: { allowEval: true, configPath: 'config/allowlist.json' },
    cdp: {
      evaluate: async () => ({
        value: undefined,
        exceptionDetails: {
          text: 'failed on wss://riot:super-secret-pw@127.0.0.1:1/',
          description: 'Error: wss://riot:super-secret-pw@127.0.0.1:1/',
          lineNumber: 1,
          columnNumber: 1,
          stackTrace: []
        }
      })
    },
    secrets: () => ['super-secret-pw']
  };
  const handlers = new Map();
  registerDomTools({ registerTool: (name, _meta, handler) => handlers.set(name, handler) }, ctx);
  const result = await handlers.get('lol_eval')({ expression: 'x' });
  assert.ok(!result.content[0].text.includes('super-secret-pw'));
});
