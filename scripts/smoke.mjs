#!/usr/bin/env node
// Live end-to-end check. Requires a running League client; CDP stages also
// require Pengu Loader with RemoteDebuggingPort set. Never run in CI.
import { loadConfig } from '../src/config.js';
import { LcuClient } from '../src/lcu/client.js';
import { RingBuffer } from '../src/lcu/buffer.js';
import { LcuEventTap } from '../src/lcu/events.js';
import { LcuStaticService } from '../src/lcu/static.js';
import { CdpClient } from '../src/cdp/client.js';
import { probeVersion } from '../src/cdp/discover.js';
import { NetworkTailer } from '../src/cdp/network.js';
import { LogSessionFinder } from '../src/logs/sessions.js';
import { LogReader } from '../src/logs/reader.js';
import { LiveGameClient } from '../src/game/client.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildContext, createServer } from '../src/index.js';

const results = [];
// A stage that cannot prove anything is neither a pass nor a failure: throwing
// INCONCLUSIVE marks it as such so it never counts as verification.
class Inconclusive extends Error {}
const record = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    const inconclusive = err instanceof Inconclusive;
    results.push({ name, ok: false, inconclusive, detail: err.message });
    console.log(`${inconclusive ? 'SKIP' : 'FAIL'} ${name} — ${err.message}`);
  }
};

const config = loadConfig({});
const lcu = new LcuClient({});
const buffer = new RingBuffer(config.eventBufferSize);
const tap = new LcuEventTap({ client: lcu, buffer });
const staticData = new LcuStaticService({ client: lcu });
const cdp = new CdpClient({ port: config.cdpPort });
const networkTailer = new NetworkTailer({ cdp: new CdpClient({ port: config.cdpPort }), config });
const logFinder = new LogSessionFinder({ lockfilePath: lcu.lockfilePath, logsDir: config.logsDir });
const logReader = new LogReader({
  finder: logFinder,
  secrets: () => (lcu.currentPassword() ? [lcu.currentPassword()] : []),
});
const gameClient = new LiveGameClient({ port: config.liveGamePort });

await record('lockfile', async () => {
  const creds = await lcu.credentials();
  return `port ${creds.port}, protocol ${creds.protocol}`; // never print the password
});

await record('REST GET /lol-gameflow/v1/gameflow-phase', async () => {
  const { status, body } = await lcu.get('/lol-gameflow/v1/gameflow-phase');
  if (status !== 200) throw new Error(`HTTP ${status}`);
  return `phase ${JSON.stringify(body)}`;
});

await record('static game data', async () => {
  const result = await staticData.query({ kind: 'champions', query: 'yasuo' });
  const hit = result.entries[0];
  if (!hit) throw new Error(`no champion matched "yasuo" among ${result.total} entries`);
  return `${result.total} champions, resolved ${hit.id} to ${hit.name}`;
});

await record('WSS event tap', async () => {
  await tap.start([]);
  // The LCU only emits when client state actually changes: sitting idle on the
  // home screen it can stay silent indefinitely, while navigating the UI produces
  // bursts. So a fixed sleep proves nothing either way — wait for the condition,
  // and report an idle client as inconclusive rather than as a pass or a failure.
  const startedAt = Date.now();
  const deadline = startedAt + 30000;
  while (buffer.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const { entries } = buffer.since(0, 5);
  if (entries.length === 0) {
    if (!tap.statusSnapshot().connected) throw new Error('tap is not connected');
    throw new Inconclusive('connected, but the client emitted nothing in 30s — click around in the client and re-run');
  }
  return `${buffer.length} event(s) in ${((Date.now() - startedAt) / 1000).toFixed(1)}s, first uri ${entries[0].uri}`;
});
tap.stop();

await record(`CDP /json/version on ${config.cdpPort}`, async () => {
  const version = await probeVersion(config.cdpPort);
  return `${version.Browser}, protocol ${version['Protocol-Version']}`;
});

await record('CDP Runtime.evaluate', async () => {
  const { value, exceptionDetails } = await cdp.evaluate('document.title');
  if (exceptionDetails) throw new Error(exceptionDetails.description ?? exceptionDetails.text);
  return `document.title = ${JSON.stringify(value)}`;
});

await record('CDP DOM query', async () => {
  const node = await cdp.domQuery('body');
  return `body class ${JSON.stringify(node?.className ?? null)}`;
});

await record('CDP page-context LCU fetch', async () => {
  const { value, exceptionDetails } = await cdp.evaluate(
    "fetch('/lol-summoner/v1/current-summoner').then(r => r.status)",
    { awaitPromise: true }
  );
  if (exceptionDetails) throw new Error(exceptionDetails.description ?? exceptionDetails.text);
  return `status ${value}`;
});

await record('CDP network tailer', async () => {
  await networkTailer.start();
  const { value } = await cdp.evaluate(
    "fetch('/lol-gameflow/v1/gameflow-phase').then(r => r.status)",
    { awaitPromise: true }
  );
  if (value !== 200) throw new Error(`probe fetch returned ${value}`);
  // The renderer delivers the three Network events asynchronously.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const { entries } = networkTailer.tail({ urlContains: 'gameflow-phase' });
  const hit = entries.find((e) => e.status === 200);
  if (!hit) throw new Error(`no gameflow request captured among ${entries.length} entries`);
  const summary = networkTailer.summary();
  networkTailer.stop();
  return `${entries.length} gameflow request(s), ${summary.groups.length} endpoint group(s), ${hit.durationMs}ms`;
});

await record('disk log tailer', async () => {
  const sessions = await logFinder.findSessions('client', 1);
  if (sessions.length === 0) {
    throw new Inconclusive('no client log sessions found on disk');
  }
  const result = await logReader.tail({ target: 'client', lines: 5 });
  return `${result.entries.length} line(s) read from ${result.filePath}`;
});

await record('live game data', async () => {
  const running = await gameClient.isGameRunning();
  if (!running) {
    throw new Inconclusive('no live match currently running (only active during in-game matches)');
  }
  const stats = await gameClient.getGameStats();
  return `${stats.gameMode} on ${stats.mapName} at ${stats.gameTime.toFixed(1)}s`;
});

await record('forensics tools (correlate & bundle)', async () => {
  const serverCtx = buildContext({});
  const server = createServer(serverCtx);
  const client = new Client({ name: 'smoke-forensics', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);

  try {
    const correlateResult = await client.callTool({
      name: 'lol_forensics_correlate',
      arguments: { format: 'summary' }
    });
    if (correlateResult.isError) {
      throw new Error(`lol_forensics_correlate failed: ${correlateResult.content?.[0]?.text}`);
    }
    const correlateSummary = JSON.parse(correlateResult.content[0].text);

    const bundleResult = await client.callTool({
      name: 'lol_forensics_bundle',
      arguments: { format: 'json' }
    });
    if (bundleResult.isError) {
      throw new Error(`lol_forensics_bundle failed: ${bundleResult.content?.[0]?.text}`);
    }
    const bundleData = JSON.parse(bundleResult.content[0].text);

    return `correlate: ${correlateSummary.total} events, bundle: LCU ${bundleData.status?.lcu?.connected ? 'connected' : 'disconnected'}`;
  } finally {
    await client.close();
    serverCtx.networkTailer?.stop?.();
    serverCtx.consoleTailer?.stop?.();
    serverCtx.lcu?.close?.();
    serverCtx.cdp?.close?.();
    serverCtx.gameClient?.close?.();
  }
});

cdp.close();
lcu.close();
gameClient.close();

const failed = results.filter((r) => !r.ok && !r.inconclusive);
const skipped = results.filter((r) => r.inconclusive);
const passed = results.filter((r) => r.ok);
console.log(`
${passed.length}/${results.length} stages passed${skipped.length > 0 ? `, ${skipped.length} inconclusive` : ''}`);
if (failed.length > 0) {
  console.log('If only the CDP stages failed, Pengu Loader is not active or RemoteDebuggingPort is unset.');
  process.exitCode = 1;
}
