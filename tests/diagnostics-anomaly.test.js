import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { detectAnomalies } from '../src/diagnostics/anomaly.js';
import { registerAnomalyTool } from '../src/tools/forensics_anomaly.js';
import { fakeContext } from './helpers/context.js';

async function connect(ctx) {
  const server = new McpServer({ name: 'test-anomaly', version: '1.0.0' });
  registerAnomalyTool(server, ctx);
  const client = new Client({ name: 'test', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);
  return { client, server };
}

test('detectAnomalies detects frontend exception bursts (5+ console errors in 10s)', () => {
  const baseTs = 1700000000000;
  const cdpEntries = [
    { kind: 'console', level: 'error', text: 'TypeError: Cannot read properties of undefined', ts: baseTs },
    { kind: 'console', level: 'error', text: 'Uncaught Error: render failed', ts: baseTs + 1000 },
    { kind: 'exception', description: 'ReferenceError: x is not defined', ts: baseTs + 2000 },
    { kind: 'console', level: 'error', text: 'ChunkLoadError: Loading chunk 4 failed', ts: baseTs + 3000 },
    { kind: 'console', level: 'error', text: 'Invariant Violation: Minified React error #130', ts: baseTs + 4000 }
  ];

  const result = detectAnomalies({ cdpEntries, windowMs: 60000 });
  assert.equal(result.verdict, 'DEGRADED');
  assert.ok(result.anomalies.length >= 1);
  const burst = result.anomalies.find((a) => a.type === 'FRONTEND_EXCEPTION_BURST');
  assert.ok(burst, 'Expected FRONTEND_EXCEPTION_BURST anomaly');
  assert.equal(burst.severity, 'DEGRADED');
  assert.equal(burst.timestamp, baseTs);
  assert.match(burst.description, /frontend exception burst/i);
  assert.equal(burst.details.count, 5);
  assert.ok(result.hypotheses.some((h) => /frontend|ui/i.test(h)));
});

test('detectAnomalies does not flag frontend exception burst when errors are sparse (< 5 in 10s)', () => {
  const baseTs = 1700000000000;
  const cdpEntries = [
    { kind: 'console', level: 'error', text: 'Error 1', ts: baseTs },
    { kind: 'console', level: 'error', text: 'Error 2', ts: baseTs + 15000 },
    { kind: 'console', level: 'error', text: 'Error 3', ts: baseTs + 30000 }
  ];

  const result = detectAnomalies({ cdpEntries, windowMs: 60000 });
  assert.equal(result.verdict, 'HEALTHY');
  assert.equal(result.anomalies.length, 0);
});

test('detectAnomalies detects LCU HTTP error clusters (consecutive 500 or 503 responses)', () => {
  const baseTs = 1700000000000;
  const networkEntries = [
    { kind: 'request', method: 'GET', url: 'https://127.0.0.1:29669/lol-summoner/v1/current-summoner', status: 200, ts: baseTs },
    { kind: 'request', method: 'GET', url: 'https://127.0.0.1:29669/lol-champ-select/v1/session', status: 500, ts: baseTs + 500 },
    { kind: 'request', method: 'POST', url: 'https://127.0.0.1:29669/lol-champ-select/v1/session/actions/1/complete', status: 503, ts: baseTs + 1000 },
    { kind: 'request', method: 'GET', url: 'https://127.0.0.1:29669/lol-champ-select/v1/session', status: 500, ts: baseTs + 1500 }
  ];

  const result = detectAnomalies({ networkEntries, windowMs: 60000 });
  assert.equal(result.verdict, 'CRITICAL');
  const cluster = result.anomalies.find((a) => a.type === 'HTTP_ERROR_CLUSTER');
  assert.ok(cluster, 'Expected HTTP_ERROR_CLUSTER anomaly');
  assert.equal(cluster.severity, 'CRITICAL');
  assert.equal(cluster.details.count, 3);
  assert.deepEqual(cluster.details.statusCodes, [500, 503, 500]);
  assert.ok(result.hypotheses.some((h) => /500|503|backend|internal server error/i.test(h)));
});

test('detectAnomalies detects WebSocket / WAMP disconnect events', () => {
  const baseTs = 1700000000000;
  const wampEntries = [
    { kind: 'event', uri: '/lol-gameflow/v1/gameflow-phase', data: 'ChampSelect', ts: baseTs },
    { kind: 'close', code: 1006, reason: 'Connection dropped abruptly', wasClean: false, ts: baseTs + 2000 }
  ];

  const result = detectAnomalies({ wampEntries, windowMs: 60000 });
  assert.equal(result.verdict, 'CRITICAL');
  const disconnect = result.anomalies.find((a) => a.type === 'WAMP_DISCONNECT');
  assert.ok(disconnect, 'Expected WAMP_DISCONNECT anomaly');
  assert.equal(disconnect.severity, 'CRITICAL');
  assert.equal(disconnect.details.code, 1006);
  assert.equal(disconnect.details.wasClean, false);
  assert.ok(result.hypotheses.some((h) => /wamp|websocket|disconnect|restart/i.test(h)));
});

test('detectAnomalies generates composite health verdict and correlated hypotheses', () => {
  const baseTs = 1700000000000;

  // 1. HEALTHY when no anomalies
  const healthy = detectAnomalies({
    wampEntries: [{ kind: 'event', uri: '/lol-gameflow/v1/gameflow-phase', ts: baseTs }],
    cdpEntries: [{ kind: 'console', level: 'info', text: 'initialized', ts: baseTs }],
    networkEntries: [{ kind: 'request', method: 'GET', url: '/test', status: 200, ts: baseTs }],
    logEntries: [{ kind: 'log', level: 'INFO', message: 'Ready', ts: baseTs }],
    windowMs: 60000
  });
  assert.equal(healthy.verdict, 'HEALTHY');
  assert.equal(healthy.anomalies.length, 0);
  assert.deepEqual(healthy.hypotheses, []);
  assert.match(healthy.summary, /healthy/i);

  // 2. Correlated cascade: WAMP disconnect + HTTP 500 errors
  const cascade = detectAnomalies({
    wampEntries: [{ kind: 'close', code: 1006, reason: 'ECONNRESET', wasClean: false, ts: baseTs + 1000 }],
    networkEntries: [
      { kind: 'request', method: 'GET', url: '/lol-chat/v1/me', status: 500, ts: baseTs + 1200 },
      { kind: 'request', method: 'GET', url: '/lol-chat/v1/me', status: 500, ts: baseTs + 1400 }
    ],
    windowMs: 60000
  });
  assert.equal(cascade.verdict, 'CRITICAL');
  assert.equal(cascade.anomalies.length, 2);
  assert.ok(cascade.hypotheses.some((h) => /crash|restart/i.test(h)));
});

test('detectAnomalies respects windowMs time window', () => {
  const recentTs = 1700000000000;
  const staleTs = recentTs - 120000; // 2 minutes ago

  const wampEntries = [
    { kind: 'close', code: 1006, reason: 'Old disconnect', wasClean: false, ts: staleTs },
    { kind: 'event', uri: '/lol-gameflow/v1/gameflow-phase', data: 'None', ts: recentTs }
  ];

  // Window of 60s should ignore the stale disconnect event from 120s ago
  const result = detectAnomalies({ wampEntries, windowMs: 60000 });
  assert.equal(result.verdict, 'HEALTHY');
  assert.equal(result.anomalies.length, 0);
});

test('lol_forensics_anomaly_detect MCP tool queries telemetry contexts and returns verdict', async () => {
  const baseTs = Date.now();
  const ctx = fakeContext({
    recorder: {
      ...fakeContext().recorder,
      dump: () => ({
        entries: [
          { kind: 'close', code: 1006, reason: 'Remote host closed connection', wasClean: false, ts: baseTs }
        ]
      })
    },
    networkTailer: {
      ...fakeContext().networkTailer,
      tail: () => ({
        entries: [
          { kind: 'request', method: 'GET', url: '/test', status: 500, ts: baseTs },
          { kind: 'request', method: 'GET', url: '/test', status: 500, ts: baseTs + 100 }
        ]
      })
    }
  });

  const { client } = await connect(ctx);
  const res = await client.callTool({
    name: 'lol_forensics_anomaly_detect',
    arguments: { windowSeconds: 60 }
  });

  assert.equal(res.isError, undefined);
  const data = JSON.parse(res.content[0].text);
  assert.equal(data.verdict, 'CRITICAL');
  assert.ok(data.anomalies.length >= 2);
  assert.ok(Array.isArray(data.hypotheses));
  assert.ok(data.hypotheses.length > 0);
  await client.close();
});

test('lol_forensics_anomaly_detect MCP tool filters anomalies by severityFilter', async () => {
  const baseTs = Date.now();
  const ctx = fakeContext({
    recorder: {
      ...fakeContext().recorder,
      dump: () => ({
        entries: [
          { kind: 'close', code: 1006, reason: 'Abrupt close', wasClean: false, ts: baseTs }
        ]
      })
    },
    consoleTailer: {
      ...fakeContext().consoleTailer,
      tail: () => ({
        entries: [
          { kind: 'console', level: 'error', text: 'err 1', ts: baseTs },
          { kind: 'console', level: 'error', text: 'err 2', ts: baseTs + 100 },
          { kind: 'console', level: 'error', text: 'err 3', ts: baseTs + 200 },
          { kind: 'console', level: 'error', text: 'err 4', ts: baseTs + 300 },
          { kind: 'console', level: 'error', text: 'err 5', ts: baseTs + 400 }
        ]
      })
    }
  });

  const { client } = await connect(ctx);

  // Filter only CRITICAL
  const resCritical = await client.callTool({
    name: 'lol_forensics_anomaly_detect',
    arguments: { severityFilter: 'CRITICAL' }
  });
  const dataCritical = JSON.parse(resCritical.content[0].text);
  assert.equal(dataCritical.verdict, 'CRITICAL');
  assert.ok(dataCritical.anomalies.every((a) => a.severity === 'CRITICAL'));

  // Filter only DEGRADED
  const resDegraded = await client.callTool({
    name: 'lol_forensics_anomaly_detect',
    arguments: { severityFilter: 'DEGRADED' }
  });
  const dataDegraded = JSON.parse(resDegraded.content[0].text);
  assert.ok(dataDegraded.anomalies.every((a) => a.severity === 'DEGRADED'));

  await client.close();
});

test('lol_forensics_anomaly_detect tool annotations match [true, false, true, false]', async () => {
  const ctx = fakeContext();
  const { client } = await connect(ctx);
  const tools = (await client.listTools()).tools;
  const tool = tools.find((t) => t.name === 'lol_forensics_anomaly_detect');
  assert.ok(tool, 'lol_forensics_anomaly_detect should be registered');
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
