/**
 * Diagnostic Bundle Generator
 * Generates an end-to-end diagnostic snapshot combining system status,
 * active timeline streams, live game telemetry, and disk log fallbacks.
 */

import { correlateTimelines } from './correlate.js';
import { redactSecrets } from '../redact.js';

function allowsSource(sources, src) {
  if (!sources) return true;
  const name = String(src).toLowerCase();
  if (typeof sources === 'string') {
    return sources.toLowerCase() === name;
  }
  if (Array.isArray(sources)) {
    return sources.some((s) => String(s).toLowerCase() === name);
  }
  if (sources instanceof Set) {
    for (const s of sources) {
      if (String(s).toLowerCase() === name) return true;
    }
  }
  return false;
}

function deepRedact(val, secrets) {
  if (!secrets || secrets.length === 0) return val;
  if (typeof val === 'string') {
    return redactSecrets(val, secrets);
  }
  if (Array.isArray(val)) {
    return val.map((item) => deepRedact(item, secrets));
  }
  if (val !== null && typeof val === 'object') {
    const res = {};
    for (const [k, v] of Object.entries(val)) {
      res[k] = deepRedact(v, secrets);
    }
    return res;
  }
  return val;
}

export async function createForensicsBundle(ctx = {}, {
  since = null,
  until = null,
  limit = 200,
  sources = null,
  includeLogTail = true,
  format = 'markdown'
} = {}) {
  // 1. System Status Collection
  let lcuConnected = false;
  try {
    lcuConnected = Boolean(ctx?.lcu?.isConnected?.());
  } catch {
    lcuConnected = false;
  }
  const lcu = {
    connected: lcuConnected,
    port: ctx?.lcu?.port ?? null,
    pid: ctx?.lcu?.pid ?? null
  };

  let cdp = { running: false, attached: false };
  try {
    cdp = ctx?.cdp?.statusSnapshot?.() ?? { running: false, attached: false };
  } catch {
    cdp = { running: false, attached: false };
  }

  let game = false;
  try {
    game = (await ctx?.gameClient?.isGameRunning?.().catch(() => false)) ?? false;
  } catch {
    game = false;
  }

  let logsWatcherStatus = { running: false };
  try {
    logsWatcherStatus = ctx?.logWatcher?.statusSnapshot?.() ?? { running: false };
  } catch {
    logsWatcherStatus = { running: false };
  }

  const watchers = {
    wamp: Boolean(ctx?.recorder?.dump),
    console: Boolean(ctx?.consoleTailer?.tail),
    network: Boolean(ctx?.networkTailer?.tail),
    logs: logsWatcherStatus
  };

  const status = { lcu, cdp, game, watchers };

  // 2. Stream Telemetry Ingest
  let wampEntries = [];
  if (allowsSource(sources, 'wamp') && typeof ctx?.recorder?.dump === 'function') {
    try {
      const res = ctx.recorder.dump({ since, until, limit });
      wampEntries = Array.isArray(res) ? res : (res?.entries ?? []);
    } catch {
      wampEntries = [];
    }
  }

  let cdpEntries = [];
  if (allowsSource(sources, 'cdp') && typeof ctx?.consoleTailer?.tail === 'function') {
    try {
      const res = ctx.consoleTailer.tail({ since, until, limit });
      cdpEntries = Array.isArray(res) ? res : (res?.entries ?? []);
    } catch {
      cdpEntries = [];
    }
  }

  let networkEntries = [];
  if (allowsSource(sources, 'network') && typeof ctx?.networkTailer?.tail === 'function') {
    try {
      const res = ctx.networkTailer.tail({ since, until, limit });
      networkEntries = Array.isArray(res) ? res : (res?.entries ?? []);
    } catch {
      networkEntries = [];
    }
  }

  let logEntries = [];
  if (allowsSource(sources, 'logs') && typeof ctx?.logWatcher?.poll === 'function') {
    try {
      const res = ctx.logWatcher.poll({ limit });
      logEntries = Array.isArray(res) ? res : (res?.entries ?? []);
    } catch {
      logEntries = [];
    }
  }

  let gameEntries = [];
  if (allowsSource(sources, 'game') && game && typeof ctx?.gameClient?.getEvents === 'function') {
    try {
      const rawEvents = await ctx.gameClient.getEvents();
      if (Array.isArray(rawEvents)) {
        gameEntries = rawEvents;
      } else if (Array.isArray(rawEvents?.Events)) {
        gameEntries = rawEvents.Events;
      }
    } catch {
      gameEntries = [];
    }
  }

  let diskLogTail = null;
  if (includeLogTail && logEntries.length === 0 && typeof ctx?.logReader?.tail === 'function') {
    try {
      const res = await ctx.logReader.tail({ target: 'client', lines: 50 });
      diskLogTail = res ?? null;
    } catch {
      diskLogTail = null;
    }
  }

  // 3. Correlation
  const summary = correlateTimelines({
    wampEntries,
    cdpEntries,
    networkEntries,
    logEntries,
    gameEntries,
    limit,
    sources,
    format: 'summary'
  });

  const timeline = correlateTimelines({
    wampEntries,
    cdpEntries,
    networkEntries,
    logEntries,
    gameEntries,
    limit,
    sources,
    format: 'events'
  });

  const narrative = correlateTimelines({
    wampEntries,
    cdpEntries,
    networkEntries,
    logEntries,
    gameEntries,
    limit,
    sources,
    format: 'narrative'
  });

  // 4. Secret Redaction
  let secrets = [];
  try {
    if (typeof ctx?.secrets === 'function') {
      secrets = ctx.secrets() ?? [];
    } else if (Array.isArray(ctx?.secrets)) {
      secrets = ctx.secrets;
    }
  } catch {
    secrets = [];
  }

  const generatedAt = (
    typeof ctx?.clock?.wall === 'function'
      ? new Date(ctx.clock.wall())
      : new Date()
  ).toISOString();

  // 5. Format Rendering
  if (format === 'json') {
    return deepRedact(
      {
        generatedAt,
        status,
        summary,
        timeline,
        diskLogTail
      },
      secrets
    );
  }

  // Markdown format
  const diskTailEntries = Array.isArray(diskLogTail)
    ? diskLogTail
    : (Array.isArray(diskLogTail?.entries) ? diskLogTail.entries : []);
  const hasDiskLogTail = diskTailEntries.length > 0;

  const lines = [];
  lines.push('# LCU Diagnostics Bundle');
  lines.push(`Generated: ${generatedAt}`);
  lines.push('');
  lines.push('## System Status');
  lines.push(`- **LCU**: ${status.lcu.connected ? 'Connected' : 'Disconnected'} (port: ${status.lcu.port ?? 'none'}, pid: ${status.lcu.pid ?? 'none'})`);
  lines.push(`- **CDP**: ${status.cdp.running ? 'Running' : 'Stopped'} (attached: ${status.cdp.attached ? 'yes' : 'no'})`);
  lines.push(`- **Game**: ${status.game ? 'Running' : 'Not running'}`);
  lines.push('- **Watchers**:');
  lines.push(`  - WAMP: ${status.watchers.wamp ? 'Active' : 'Inactive'}`);
  lines.push(`  - Console: ${status.watchers.console ? 'Active' : 'Inactive'}`);
  lines.push(`  - Network: ${status.watchers.network ? 'Active' : 'Inactive'}`);
  lines.push(`  - Logs: ${status.watchers.logs?.running ? 'Active' : 'Inactive'}`);
  lines.push('');
  lines.push('## Telemetry Summary');
  lines.push(`- **Total Events**: ${summary.total}`);
  lines.push(`- **Errors**: ${summary.errorCount}`);
  lines.push(`- **Time Span**: ${summary.timeSpanMs}ms`);
  lines.push('- **Stream Breakdown**:');
  lines.push(`  - WAMP: ${summary.sources.wamp}`);
  lines.push(`  - CDP Console: ${summary.sources.cdp}`);
  lines.push(`  - Network: ${summary.sources.network}`);
  lines.push(`  - Logs: ${summary.sources.logs}`);
  lines.push(`  - Game: ${summary.sources.game}`);
  lines.push('');
  lines.push('## Timeline Narrative');
  lines.push(narrative);

  if (hasDiskLogTail) {
    lines.push('');
    lines.push('## Disk Logs Tail');
    const logLines = diskTailEntries
      .map((e) => e.raw ?? e.message ?? (typeof e === 'string' ? e : JSON.stringify(e)))
      .filter(Boolean);
    lines.push(logLines.join('\n'));
  }

  const rawMarkdown = lines.join('\n');
  return redactSecrets(rawMarkdown, secrets);
}
