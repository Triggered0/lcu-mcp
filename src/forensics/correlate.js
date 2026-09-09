/**
 * Timeline Correlation Engine for LCU WAMP events and CDP console entries.
 */

function formatTimestamp(ts) {
  if (typeof ts !== 'number' || Number.isNaN(ts)) {
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

export function formatNarrativeLine(entry) {
  if (!entry) return '';
  let normalized = entry;
  if (!entry.summary) {
    if (entry.source === 'wamp' || entry.uri || entry.endpoint) {
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
  limit = 100,
  levels = null,
  format = 'narrative'
} = {}) {
  const wamp = Array.isArray(wampEntries) ? wampEntries.map(normalizeWampEntry) : [];
  let cdp = Array.isArray(cdpEntries) ? cdpEntries.map(normalizeCdpEntry) : [];

  if (levels && Array.isArray(levels) && levels.length > 0) {
    const allowed = new Set(levels);
    cdp = cdp.filter((e) => e.kind === 'reattach' || (e.level && allowed.has(e.level)));
  }

  const combined = [...wamp, ...cdp];
  combined.sort((a, b) => {
    const aTs = a.ts ?? a.wallTs ?? 0;
    const bTs = b.ts ?? b.wallTs ?? 0;
    return aTs - bTs;
  });

  const sliced = combined.slice(0, limit);

  if (format === 'events') {
    return sliced;
  }

  if (format === 'summary') {
    if (sliced.length === 0) {
      return {
        total: 0,
        wampCount: 0,
        cdpCount: 0,
        errorCount: 0,
        timeSpanMs: 0,
        firstTs: null,
        lastTs: null
      };
    }

    let wampCount = 0;
    let cdpCount = 0;
    let errorCount = 0;

    for (const entry of sliced) {
      if (entry.source === 'wamp') {
        wampCount += 1;
        if (entry.kind === 'error') {
          errorCount += 1;
        }
      } else if (entry.source === 'cdp') {
        cdpCount += 1;
        if (entry.kind === 'exception' || entry.kind === 'error' || entry.level === 'error') {
          errorCount += 1;
        }
      }
    }

    const firstEntry = sliced[0];
    const lastEntry = sliced[sliced.length - 1];
    const firstTs = firstEntry.ts ?? firstEntry.wallTs ?? null;
    const lastTs = lastEntry.ts ?? lastEntry.wallTs ?? null;
    const timeSpanMs = (firstTs !== null && lastTs !== null) ? Math.max(0, lastTs - firstTs) : 0;

    return {
      total: sliced.length,
      wampCount,
      cdpCount,
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
