import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { extractPerformanceMetrics } from '../src/diagnostics/performance.js';
import { registerCdpPerformanceTool } from '../src/tools/cdp_performance.js';
import { CdpUnavailableError } from '../src/cdp/discover.js';
import { fakeContext } from './helpers/context.js';

async function connect(ctx) {
  const server = new McpServer({ name: 'test-perf', version: '1.0.0' });
  registerCdpPerformanceTool(server, ctx);
  const client = new Client({ name: 'test', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);
  return { client, server };
}

test('extractPerformanceMetrics converts raw CDP metrics to human-readable units and flags thresholds', () => {
  const rawMetrics = [
    { name: 'JSHeapUsedSize', value: 314572800 }, // 300 MB
    { name: 'JSHeapTotalSize', value: 419430400 }, // 400 MB
    { name: 'Nodes', value: 18000 },
    { name: 'LayoutCount', value: 120 },
    { name: 'RecalcStyleCount', value: 450 },
    { name: 'TaskDuration', value: 12.5 },
    { name: 'ScriptDuration', value: 8.2 }
  ];

  const result = extractPerformanceMetrics(rawMetrics);
  assert.equal(result.jsHeapUsedMb, 300);
  assert.equal(result.jsHeapTotalMb, 400);
  assert.equal(result.heapUtilizationRatio, 0.75);
  assert.equal(result.nodesCount, 18000);
  assert.equal(result.layoutCount, 120);
  assert.equal(result.recalcStyleCount, 450);
  assert.equal(result.taskDurationSeconds, 12.5);
  assert.equal(result.scriptDurationSeconds, 8.2);
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[0], /heap/i);
  assert.match(result.warnings[1], /nodes/i);
});

test('extractPerformanceMetrics handles empty or missing metrics gracefully', () => {
  const result = extractPerformanceMetrics([]);
  assert.equal(result.jsHeapUsedMb, 0);
  assert.equal(result.jsHeapTotalMb, 0);
  assert.equal(result.heapUtilizationRatio, 0);
  assert.equal(result.nodesCount, 0);
  assert.equal(result.layoutCount, 0);
  assert.equal(result.recalcStyleCount, 0);
  assert.equal(result.taskDurationSeconds, 0);
  assert.equal(result.scriptDurationSeconds, 0);
  assert.deepEqual(result.warnings, []);
});

test('extractPerformanceMetrics flags only high JS heap usage when above 250 MB', () => {
  const rawMetrics = [
    { name: 'JSHeapUsedSize', value: 272629760 }, // 260 MB
    { name: 'JSHeapTotalSize', value: 314572800 }, // 300 MB
    { name: 'Nodes', value: 1000 }
  ];
  const result = extractPerformanceMetrics(rawMetrics);
  assert.equal(result.jsHeapUsedMb, 260);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /High JS Heap usage/);
});

test('extractPerformanceMetrics flags only high DOM node count when above 15000', () => {
  const rawMetrics = [
    { name: 'JSHeapUsedSize', value: 104857600 }, // 100 MB
    { name: 'JSHeapTotalSize', value: 209715200 }, // 200 MB
    { name: 'Nodes', value: 16000 }
  ];
  const result = extractPerformanceMetrics(rawMetrics);
  assert.equal(result.nodesCount, 16000);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /High DOM node count/);
});

test('lol_cdp_performance calls Performance.enable and Performance.getMetrics, returning normalized metrics', async () => {
  const sent = [];
  const ctx = fakeContext({
    cdp: {
      ...fakeContext().cdp,
      send: async (method, params = {}) => {
        sent.push({ method, params });
        if (method === 'Performance.getMetrics') {
          return {
            metrics: [
              { name: 'JSHeapUsedSize', value: 104857600 }, // 100 MB
              { name: 'JSHeapTotalSize', value: 209715200 }, // 200 MB
              { name: 'Nodes', value: 5000 },
              { name: 'LayoutCount', value: 10 },
              { name: 'RecalcStyleCount', value: 20 },
              { name: 'TaskDuration', value: 1.5 },
              { name: 'ScriptDuration', value: 0.8 }
            ]
          };
        }
        return {};
      }
    }
  });

  const { client } = await connect(ctx);
  const result = await client.callTool({ name: 'lol_cdp_performance', arguments: {} });
  assert.equal(result.isError, undefined);
  assert.deepEqual(sent, [
    { method: 'Performance.enable', params: {} },
    { method: 'Performance.getMetrics', params: {} }
  ]);
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.jsHeapUsedMb, 100);
  assert.equal(data.jsHeapTotalMb, 200);
  assert.equal(data.heapUtilizationRatio, 0.5);
  assert.equal(data.nodesCount, 5000);
  assert.equal(data.layoutCount, 10);
  assert.equal(data.recalcStyleCount, 20);
  assert.equal(data.taskDurationSeconds, 1.5);
  assert.equal(data.scriptDurationSeconds, 0.8);
  assert.equal(data.warnings.length, 0);
  await client.close();
});

test('lol_cdp_performance surfaces Pengu prerequisite when CDP throws CdpUnavailableError', async () => {
  const ctx = fakeContext({
    cdp: {
      ...fakeContext().cdp,
      send: async () => {
        throw new CdpUnavailableError(8888, 'ECONNREFUSED');
      }
    }
  });

  const { client } = await connect(ctx);
  const result = await client.callTool({ name: 'lol_cdp_performance', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Pengu Loader/);
  assert.match(result.content[0].text, /RemoteDebuggingPort/);
  await client.close();
});

test('lol_cdp_performance annotations match [true, false, true, true]', async () => {
  const ctx = fakeContext();
  const { client } = await connect(ctx);
  const tools = (await client.listTools()).tools;
  const tool = tools.find((t) => t.name === 'lol_cdp_performance');
  assert.ok(tool, 'lol_cdp_performance should be registered');
  assert.deepEqual(
    [
      tool.annotations.readOnlyHint,
      tool.annotations.destructiveHint,
      tool.annotations.idempotentHint,
      tool.annotations.openWorldHint
    ],
    [true, false, true, true]
  );
  await client.close();
});
