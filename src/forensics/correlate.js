/**
 * Timeline Correlation Engine for LCU WAMP events, CDP console entries,
 * CDP network requests, disk logs, and live game events.
 */

function formatTimestamp(ts) {
  if (ts === null || ts === undefined) {
    return '00:00:00.000';
  }
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '00:00:00.000';
    return d.toISOString().slice(11, 23);
  } catch {
    return '00:00:00.000';
  }
}

export function normalizeWampEntry(entry = {}) {
  const kind = entry.kind ?? (entry.uri ? 'event' : 'unknown');
  let summary = '';
  if (kind === 'event') {
    let dataStr;
    try {
      dataStr = JSON.stringify(entry.data ?? null);
    } catch {
      dataStr = '[unserialisable]';
    }
    const raw = `${entry.uri ?? ''} -> ${dataStr}`;
    summary = raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;
  } else {
    const detail = entry.reason ?? entry.message ?? '';
    summary = detail ? `[${kind}] ${detail}` : `[${kind}]`;
  }

  return {
    source: 'wamp',
    ts: entry.ts,
    wallTs: entry.wallTs,
    kind,
    summary
  };
}

export function normalizeCdpEntry(entry = {}) {
  const kind = entry.kind ?? 'console';
  const level = entry.level ?? (kind === 'exception' ? 'error' : 'log');
  let summary = '';
  if (kind === 'exception') {
    summary = (entry.description && (!entry.text || entry.text === 'Uncaught'))
      ? entry.description
      : (entry.text ?? entry.description ?? 'Exception');
  } else if (kind === 'console') {
    const text = entry.text ?? entry.args ?? '';
    summary = text ? `[${level}] ${text}` : `[${level}]`;
  } else {
    const detail = entry.text ?? entry.args ?? entry.reason ?? entry.message ?? '';
    summary = detail ? `[${kind}] ${detail}` : `[${kind}]`;
  }

  return {
    source: 'cdp',
    ts: entry.ts,
    wallTs: entry.wallTs,
    kind,
    level,
    summary
  };
}

export function normalizeNetworkEntry(entry = {}) {
  const kind = entry.kind ?? (entry.targetId ? 'reattach' : 'request');
  const ts = entry.ts;
  const wallTs = entry.wallTs ?? entry.startedAt ?? entry.ts;
  const status = entry.status;
  const failed = Boolean(entry.failed);
  const isError = Boolean(entry.failed || (typeof entry.status === 'number' && entry.status >= 400));

  let summary = '';
  if (kind === 'request') {
    const method = entry.method ?? 'GET';
    const url = entry.url ?? '';
    const statusPart = status !== undefined && status !== null ? status : (failed ? 'failed' : 'unknown');
    const durPart = typeof entry.durationMs === 'number' ? ` (${entry.durationMs}ms)` : '';
    const errPart = entry.errorText ? ` [${entry.errorText}]` : '';
    summary = `${method} ${url} -> ${statusPart}${durPart}${errPart}`;
  } else if (kind === 'reattach') {
    const target = entry.targetId ?? 'unknown';
    const gap = entry.gapMs ? ` after ${entry.gapMs}ms` : '';
    summary = `[reattach] Target ${target}${gap}`;
  } else {
    summary = entry.url ? `[${kind}] ${entry.url}` : `[${kind}]`;
  }

  return {
    source: 'network',
    ts,
    wallTs,
    kind,
    status,
    failed,
    summary,
    isError
  };
}

export function normalizeLogEntry(entry = {}) {
  const kind = entry.kind ?? 'log';
  const target = entry.target ?? 'client';
  const level = entry.level ?? 'INFO';
  const ts = entry.ts;
  const wallTs = entry.wallTime ?? entry.wallTs ?? entry.ts;
  const msg = entry.message ?? entry.raw ?? '';
  const summary = msg ? `[${target}:${level}] ${msg}` : `[${target}:${level}]`;

  const upperLevel = (typeof level === 'string' ? level : '').toUpperCase();
  const isError =
    upperLevel === 'ERROR' ||
    (upperLevel === 'ALWAYS' && /error|fatal|fail/i.test(msg));

  return {
    source: 'logs',
    ts,
    wallTs,
    kind,
    target,
    level,
    summary,
    isError
  };
}

export function normalizeGameEntry(entry = {}) {
  const kind = entry.EventName ?? entry.kind ?? 'event';
  const ts = entry.ts;
  const wallTs = entry.wallTs ?? entry.ts;

  const timePart = typeof entry.EventTime === 'number' ? ` @ ${entry.EventTime}s` : '';
  let detail = '';
  if (entry.KillerName && entry.VictimName) {
    detail = `${entry.KillerName} killed ${entry.VictimName}`;
  } else if (entry.KillerName) {
    detail = entry.Recipient ? `${entry.KillerName} (${entry.Recipient})` : `${entry.KillerName}`;
  } else if (entry.Result) {
    detail = String(entry.Result);
  } else if (entry.detail || entry.message) {
    detail = String(entry.detail ?? entry.message);
  }

  const summary = detail ? `${kind}${timePart}: ${detail}` : `${kind}${timePart}`;

  return {
    source: 'game',
    ts,
    wallTs,
    kind,
    summary,
    isError: false
  };
}

export function formatNarrativeLine(entry) {
  if (!entry) return '';
  let normalized = entry;
  if (!entry.summary) {
    if (entry.source === 'network' || entry.method || entry.requestId) {
      normalized = normalizeNetworkEntry(entry);
    } else if (entry.source === 'logs' || entry.target || (entry.level && entry.message)) {
      normalized = normalizeLogEntry(entry);
    } else if (entry.source === 'game' || entry.EventName || entry.EventID !== undefined) {
      normalized = normalizeGameEntry(entry);
    } else if (entry.source === 'wamp' || entry.uri || entry.endpoint) {
      normalized = normalizeWampEntry(entry);
    } else if (entry.source === 'cdp' || entry.args || entry.targetId) {
      normalized = normalizeCdpEntry(entry);
    }
  }
  const timeStr = formatTimestamp(normalized.wallTs ?? normalized.ts);
  const sourceStr = (normalized.source ?? 'unknown').toUpperCase();
  const kindStr = normalized.kind ?? 'unknown';
  const summaryStr = normalized.summary ?? '';
  return `[${timeStr}] [${sourceStr}:${kindStr}] ${summaryStr}`;
}

export function correlateTimelines({
  wampEntries = [],
  cdpEntries = [],
  networkEntries = [],
  logEntries = [],
  gameEntries = [],
  limit = 100,
  sources = null,
  levels = null,
  format = 'narrative'
} = {}) {
  const wamp = Array.isArray(wampEntries) ? wampEntries.map(normalizeWampEntry) : [];
  let cdp = Array.isArray(cdpEntries) ? cdpEntries.map(normalizeCdpEntry) : [];
  const network = Array.isArray(networkEntries) ? networkEntries.map(normalizeNetworkEntry) : [];
  const logs = Array.isArray(logEntries) ? logEntries.map(normalizeLogEntry) : [];
  const game = Array.isArray(gameEntries) ? gameEntries.map(normalizeGameEntry) : [];

  if (levels && Array.isArray(levels) && levels.length > 0) {
    const allowed = new Set(levels.map((l) => String(l).toLowerCase()));
    cdp = cdp.filter((e) => e.kind === 'reattach' || (e.level && allowed.has(String(e.level).toLowerCase())));
  }

  let combined = [...wamp, ...cdp, ...network, ...logs, ...game];

  if (sources) {
    let allowedSources = null;
    if (sources instanceof Set) {
      allowedSources = new Set([...sources].map((s) => String(s).toLowerCase()));
    } else if (Array.isArray(sources)) {
      allowedSources = new Set(sources.map((s) => String(s).toLowerCase()));
    }
    if (allowedSources) {
      combined = combined.filter((e) => allowedSources.has(e.source));
    }
  }

  combined.sort((a, b) => {
    const aTs = a.wallTs ?? a.ts ?? 0;
    const bTs = b.wallTs ?? b.ts ?? 0;
    return aTs - bTs;
  });

  const sliced = limit !== null && limit !== undefined ? combined.slice(0, limit) : combined;

  if (format === 'events') {
    return sliced;
  }

  if (format === 'summary') {
    if (sliced.length === 0) {
      return {
        total: 0,
        sources: {
          wamp: 0,
          cdp: 0,
          network: 0,
          logs: 0,
          game: 0
        },
        errorCount: 0,
        timeSpanMs: 0,
        firstTs: null,
        lastTs: null
      };
    }

    let wampCount = 0;
    let cdpCount = 0;
    let networkCount = 0;
    let logCount = 0;
    let gameCount = 0;
    let errorCount = 0;

    for (const entry of sliced) {
      if (entry.source === 'wamp') {
        wampCount += 1;
      } else if (entry.source === 'cdp') {
        cdpCount += 1;
      } else if (entry.source === 'network') {
        networkCount += 1;
      } else if (entry.source === 'logs') {
        logCount += 1;
      } else if (entry.source === 'game') {
        gameCount += 1;
      }

      if (
        entry.isError === true ||
        entry.kind === 'error' ||
        entry.kind === 'exception' ||
        (typeof entry.level === 'string' && entry.level.toUpperCase() === 'ERROR')
      ) {
        errorCount += 1;
      }
    }

    const firstEntry = sliced[0];
    const lastEntry = sliced[sliced.length - 1];
    const firstTs = firstEntry.wallTs ?? firstEntry.ts ?? null;
    const lastTs = lastEntry.wallTs ?? lastEntry.ts ?? null;
    const timeSpanMs =
      typeof firstTs === 'number' && typeof lastTs === 'number'
        ? Math.max(0, lastTs - firstTs)
        : 0;

    return {
      total: sliced.length,
      sources: {
        wamp: wampCount,
        cdp: cdpCount,
        network: networkCount,
        logs: logCount,
        game: gameCount
      },
      errorCount,
      timeSpanMs,
      firstTs,
      lastTs
    };
  }

  // format === 'narrative' (default)
  const header = `=== CORRELATED FORENSICS TIMELINE (${sliced.length} events) ===`;
  if (sliced.length === 0) {
    return header;
  }
  const lines = [header, ...sliced.map(formatNarrativeLine)];
  return lines.join('\n');
}
