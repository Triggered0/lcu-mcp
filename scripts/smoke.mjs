#!/usr/bin/env node
// Live end-to-end check. Requires a running League client; CDP stages also
// require Pengu Loader with RemoteDebuggingPort set. Never run in CI.
import { loadConfig } from '../src/config.js';
import { LcuClient } from '../src/lcu/client.js';
import { RingBuffer } from '../src/lcu/buffer.js';
import { LcuEventTap } from '../src/lcu/events.js';
import { CdpClient } from '../src/cdp/client.js';
import { probeVersion } from '../src/cdp/discover.js';

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
const cdp = new CdpClient({ port: config.cdpPort });

await record('lockfile', async () => {
  const creds = await lcu.credentials();
  return `port ${creds.port}, protocol ${creds.protocol}`; // never print the password
});

await record('REST GET /lol-gameflow/v1/gameflow-phase', async () => {
  const { status, body } = await lcu.get('/lol-gameflow/v1/gameflow-phase');
  if (status !== 200) throw new Error(`HTTP ${status}`);
  return `phase ${JSON.stringify(body)}`;
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
  const value = await cdp.evaluate('document.title');
  return `document.title = ${JSON.stringify(value)}`;
});

await record('CDP DOM query', async () => {
  const node = await cdp.domQuery('body');
  return `body class ${JSON.stringify(node?.className ?? null)}`;
});

await record('CDP page-context LCU fetch', async () => {
  const value = await cdp.evaluate(
    "fetch('/lol-summoner/v1/current-summoner').then(r => r.status)",
    { awaitPromise: true }
  );
  return `status ${value}`;
});

cdp.close();
lcu.close();

const failed = results.filter((r) => !r.ok && !r.inconclusive);
const skipped = results.filter((r) => r.inconclusive);
const passed = results.filter((r) => r.ok);
console.log(`
${passed.length}/${results.length} stages passed${skipped.length > 0 ? `, ${skipped.length} inconclusive` : ''}`);
if (failed.length > 0) {
  console.log('If only the CDP stages failed, Pengu Loader is not active or RemoteDebuggingPort is unset.');
  process.exitCode = 1;
}
