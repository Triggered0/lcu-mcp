import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { analyzeBottlenecks, normalizeEndpoint, summarizeInitiator } from '../src/diagnostics/bottlenecks.js';
import { registerNetworkBottlenecksTool } from '../src/tools/cdp_bottlenecks.js';
import { fakeContext } from './helpers/context.js';

async function connect(ctx) {
  const server = new McpServer({ name: 'test-bottlenecks', version: '1.0.0' });
  registerNetworkBottlenecksTool(server, ctx);
  const client = new Client({ name: 'test', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);
  return { client, server };
}

test('normalizeEndpoint strips origin, query params, hashes, and replaces dynamic IDs with {id}', () => {
  assert.equal(
    normalizeEndpoint('https://127.0.0.1:29669/lol-champ-select/v1/session?tab=1#top'),
    '/lol-champ-select/v1/session'
  );
  assert.equal(
    normalizeEndpoint('/lol-summoner/v1/summoners/12345678'),
    '/lol-summoner/v1/summoners/{id}'
  );
  assert.equal(
    normalizeEndpoint('https://127.0.0.1:29669/lol-champ-select/v1/session/actions/42/complete'),
    '/lol-champ-select/v1/session/actions/{id}/complete'
  );
  assert.equal(
    normalizeEndpoint('https://127.0.0.1:29669/fe/lol-champ-select/main.js'),
    '/fe/lol-champ-select/main.js'
  );
  assert.equal(normalizeEndpoint(''), '/');
});

test('summarizeInitiator formats script location and function name', () => {
  const initiatorFromTailer = {
    type: 'script',
    functionName: 'fetchSession',
    url: 'https://127.0.0.1:29669/fe/lol-champ-select/main.js',
    line: 142
  };
  assert.equal(
    summarizeInitiator(initiatorFromTailer),
    'fetchSession @ https://127.0.0.1:29669/fe/lol-champ-select/main.js:142'
  );

  const initiatorFromCdpStack = {
    type: 'script',
    stack: {
      callFrames: [
        {
          functionName: 'sendAction',
          url: 'https://127.0.0.1:29669/fe/bundle.js',
          lineNumber: 88,
          columnNumber: 12
        }
      ]
    }
  };
  assert.equal(
    summarizeInitiator(initiatorFromCdpStack),
    'sendAction @ https://127.0.0.1:29669/fe/bundle.js:88:12'
  );

  assert.equal(summarizeInitiator(null), null);
});

test('analyzeBottlenecks filters and ranks the slowest HTTP requests by total duration', () => {
  const entries = [
    { kind: 'request', method: 'GET', url: 'https://127.0.0.1:29669/fast', durationMs: 45, status: 200, type: 'XHR' },
    { kind: 'request', method: 'GET', url: 'https://127.0.0.1:29669/slow-1', durationMs: 350, status: 200, type: 'Fetch' },
    { kind: 'request', method: 'POST', url: 'https://127.0.0.1:29669/slow-worst', durationMs: 1250, status: 200, type: 'Fetch' },
    { kind: 'request', method: 'GET', url: 'https://127.0.0.1:29669/slow-2', durationMs: 250, status: 200, type: 'XHR' },
    { kind: 'reattach', previousTargetId: 'P1', targetId: 'P2' }
  ];

  const result = analyzeBottlenecks(entries, { thresholdMs: 200, limit: 2 });
  assert.equal(result.slowestRequests.length, 2);
  assert.equal(result.slowestRequests[0].url, 'https://127.0.0.1:29669/slow-worst');
  assert.equal(result.slowestRequests[0].durationMs, 1250);
  assert.equal(result.slowestRequests[0].method, 'POST');
  assert.equal(result.slowestRequests[1].url, 'https://127.0.0.1:29669/slow-1');
  assert.equal(result.slowestRequests[1].durationMs, 350);
});

test('analyzeBottlenecks calculates P50, P90, P99, avgMs, maxMs per endpoint pattern', () => {
  const entries = [
    { kind: 'request', method: 'GET', url: 'https://127.0.0.1:29669/lol-champ-select/v1/session', durationMs: 100, status: 200 },
    { kind: 'request', method: 'GET', url: 'https://127.0.0.1:29669/lol-champ-select/v1/session?tab=1', durationMs: 200, status: 200 },
    { kind: 'request', method: 'GET', url: 'https://127.0.0.1:29669/lol-champ-select/v1/session', durationMs: 300, status: 200 },
    { kind: 'request', method: 'GET', url: 'https://127.0.0.1:29669/lol-champ-select/v1/session', durationMs: 400, status: 200 },
    { kind: 'request', method: 'GET', url: 'https://127.0.0.1:29669/lol-champ-select/v1/session', durationMs: 500, status: 200 },
    { kind: 'request', method: 'GET', url: 'https://127.0.0.1:29669/lol-summoner/v1/current-summoner', durationMs: 50, status: 200 }
  ];

  const result = analyzeBottlenecks(entries);
  const champSelectStats = result.endpointLatencyStats.find(
    (e) => e.endpoint === '/lol-champ-select/v1/session'
  );
  assert.ok(champSelectStats, 'Should find endpoint latency stats for /lol-champ-select/v1/session');
  assert.equal(champSelectStats.count, 5);
  assert.equal(champSelectStats.p50, 300);
  assert.equal(champSelectStats.p90, 500);
  assert.equal(champSelectStats.p99, 500);
  assert.equal(champSelectStats.avgMs, 300);
  assert.equal(champSelectStats.maxMs, 500);
});

test('analyzeBottlenecks groups failed asset loads (image 404s, failed plugin scripts)', () => {
  const entries = [
    {
      kind: 'request',
      method: 'GET',
      url: 'https://127.0.0.1:29669/fe/lol-champ-select/missing-icon.png',
      status: 404,
      type: 'Image',
      durationMs: 25
    },
    {
      kind: 'request',
      method: 'GET',
      url: 'https://127.0.0.1:29669/fe/lol-champ-select/missing-icon.png',
      status: 404,
      type: 'Image',
      durationMs: 30
    },
    {
      kind: 'request',
      method: 'GET',
      url: 'https://127.0.0.1:29669/fe/plugins/broken-plugin.js',
      status: 500,
      type: 'Script',
      durationMs: 110
    },
    {
      kind: 'request',
      method: 'GET',
      url: 'https://127.0.0.1:29669/fe/style.css',
      status: null,
      failed: true,
      errorText: 'net::ERR_ABORTED',
      type: 'Stylesheet',
      durationMs: 5
    },
    {
      kind: 'request',
      method: 'GET',
      url: 'https://127.0.0.1:29669/fe/ok.png',
      status: 200,
      type: 'Image',
      durationMs: 15
    }
  ];

  const result = analyzeBottlenecks(entries);
  assert.equal(result.failedAssets.length, 3);

  const missingIcon = result.failedAssets.find((a) => a.url.includes('missing-icon.png'));
  assert.ok(missingIcon);
  assert.equal(missingIcon.count, 2);
  assert.equal(missingIcon.status, 404);
  assert.equal(missingIcon.type, 'Image');

  const brokenScript = result.failedAssets.find((a) => a.url.includes('broken-plugin.js'));
  assert.ok(brokenScript);
  assert.equal(brokenScript.count, 1);
  assert.equal(brokenScript.status, 500);

  const abortedStyle = result.failedAssets.find((a) => a.url.includes('style.css'));
  assert.ok(abortedStyle);
  assert.equal(abortedStyle.failed, true);
  assert.equal(abortedStyle.errorText, 'net::ERR_ABORTED');
});

test('analyzeBottlenecks correlates initiator stack frames for slowest requests', () => {
  const entries = [
    {
      kind: 'request',
      method: 'GET',
      url: 'https://127.0.0.1:29669/lol-champ-select/v1/session',
      durationMs: 850,
      status: 200,
      type: 'Fetch',
      initiator: {
        type: 'script',
        functionName: 'pollSession',
        url: 'https://127.0.0.1:29669/fe/lol-champ-select/champ-select.js',
        line: 215
      }
    }
  ];

  const result = analyzeBottlenecks(entries, { thresholdMs: 200 });
  assert.equal(result.slowestRequests.length, 1);
  assert.equal(
    result.slowestRequests[0].initiator,
    'pollSession @ https://127.0.0.1:29669/fe/lol-champ-select/champ-select.js:215'
  );
  assert.equal(
    result.slowestRequests[0].initiatorSummary,
    'pollSession @ https://127.0.0.1:29669/fe/lol-champ-select/champ-select.js:215'
  );
});

test('analyzeBottlenecks generates a descriptive summary string', () => {
  const entries = [
    { kind: 'request', method: 'GET', url: 'https://127.0.0.1:29669/fast', durationMs: 50, status: 200 },
    { kind: 'request', method: 'GET', url: 'https://127.0.0.1:29669/slow', durationMs: 400, status: 200 },
    { kind: 'request', method: 'GET', url: 'https://127.0.0.1:29669/bad.png', durationMs: 20, status: 404, type: 'Image' }
  ];

  const result = analyzeBottlenecks(entries, { thresholdMs: 200 });
  assert.match(result.summary, /3 network requests/i);
  assert.match(result.summary, /1 slow request/i);
  assert.match(result.summary, /400ms/);
  assert.match(result.summary, /1 failed asset/i);
});

test('lol_cdp_network_bottlenecks MCP tool runs analysis and returns expected shape', async () => {
  const ctx = fakeContext({
    networkTailer: {
      ...fakeContext().networkTailer,
      tail: () => ({
        entries: [
          {
            kind: 'request',
            method: 'GET',
            url: 'https://127.0.0.1:29669/lol-champ-select/v1/session',
            durationMs: 650,
            status: 200,
            type: 'Fetch',
            initiator: {
              type: 'script',
              functionName: 'onMount',
              url: 'https://127.0.0.1:29669/fe/main.js',
              line: 42
            }
          },
          {
            kind: 'request',
            method: 'GET',
            url: 'https://127.0.0.1:29669/fe/missing.png',
            durationMs: 30,
            status: 404,
            type: 'Image'
          }
        ]
      })
    }
  });

  const { client } = await connect(ctx);

  const res = await client.callTool({
    name: 'lol_cdp_network_bottlenecks',
    arguments: { thresholdMs: 300, limit: 10 }
  });

  assert.equal(res.isError, undefined);
  const data = JSON.parse(res.content[0].text);
  assert.equal(data.slowestRequests.length, 1);
  assert.equal(data.slowestRequests[0].durationMs, 650);
  assert.equal(data.slowestRequests[0].initiator, 'onMount @ https://127.0.0.1:29669/fe/main.js:42');
  assert.equal(data.failedAssets.length, 1);
  assert.equal(data.failedAssets[0].status, 404);
  assert.ok(data.endpointLatencyStats.length >= 1);
  assert.match(data.summary, /slow request/i);

  await client.close();
});

test('lol_cdp_network_bottlenecks respects includeInitiators: false', async () => {
  const ctx = fakeContext({
    networkTailer: {
      ...fakeContext().networkTailer,
      tail: () => ({
        entries: [
          {
            kind: 'request',
            method: 'GET',
            url: 'https://127.0.0.1:29669/slow',
            durationMs: 500,
            status: 200,
            initiator: {
              type: 'script',
              functionName: 'leak',
              url: 'https://127.0.0.1:29669/fe/main.js',
              line: 10
            }
          }
        ]
      })
    }
  });

  const { client } = await connect(ctx);

  const res = await client.callTool({
    name: 'lol_cdp_network_bottlenecks',
    arguments: { thresholdMs: 200, includeInitiators: false }
  });

  const data = JSON.parse(res.content[0].text);
  assert.equal(data.slowestRequests[0].initiator, null);

  await client.close();
});

test('lol_cdp_network_bottlenecks declares annotations [true, false, true, false]', async () => {
  const ctx = fakeContext();
  const { client } = await connect(ctx);
  const tools = (await client.listTools()).tools;
  const tool = tools.find((t) => t.name === 'lol_cdp_network_bottlenecks');
  assert.ok(tool, 'lol_cdp_network_bottlenecks should be registered');
  assert.deepEqual(
    [
      tool.annotations.readOnlyHint,
      tool.annotations.destructiveHint,
      tool.annotations.idempotentHint,
      tool.annotations.openWorldHint
    ],
    [true, false, true, false]
  );
  await client.close();
});
