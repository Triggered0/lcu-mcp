/**
 * Network Bottlenecks & Slow Endpoint Diagnostics Engine.
 *
 * Analyzes CDP network requests captured from the League Client UI
 * to identify latency bottlenecks, endpoint latency percentiles (P50/P90/P99),
 * failed asset loads (HTTP 4xx/5xx or transport failures), and initiator stack traces.
 */

export function normalizeEndpoint(url) {
  if (!url || typeof url !== 'string') return '/';
  let path = url;
  try {
    if (url.includes('://')) {
      path = new URL(url).pathname;
    } else {
      path = url.split('?')[0].split('#')[0];
    }
  } catch {
    path = url.split('?')[0].split('#')[0];
  }

  if (!path.startsWith('/')) {
    path = '/' + path;
  }

  // Normalize UUIDs to {id}
  path = path.replace(
    /\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?=\/|$)/g,
    '/{id}'
  );

  // Normalize numeric IDs to {id} (e.g. /v1/summoners/12345/profile -> /v1/summoners/{id}/profile)
  path = path.replace(/\/\d+(?=\/|$)/g, '/{id}');

  return path;
}

export function summarizeInitiator(initiator) {
  if (!initiator) return null;
  if (typeof initiator === 'string') return initiator;

  // CDP callFrames format
  const frame = initiator.stack?.callFrames?.[0];
  if (frame) {
    const fn = frame.functionName && frame.functionName !== '(anonymous)' ? `${frame.functionName} @ ` : '';
    const line = frame.lineNumber != null ? `:${frame.lineNumber}` : '';
    const col = frame.columnNumber != null ? `:${frame.columnNumber}` : '';
    return `${fn}${frame.url || '(unknown)'}${line}${col}`;
  }

  // NetworkTailer initiatorTop format ({ type, functionName, url, line })
  if (initiator.url) {
    const fn = initiator.functionName && initiator.functionName !== '(anonymous)' ? `${initiator.functionName} @ ` : '';
    const line = initiator.line != null ? `:${initiator.line}` : '';
    return `${fn}${initiator.url}${line}`;
  }

  if (initiator.type) {
    return initiator.type;
  }
  return String(initiator);
}

function calcPercentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  const clamped = Math.max(0, Math.min(sorted.length - 1, index));
  return sorted[clamped];
}

export function analyzeBottlenecks(
  networkEntries = [],
  { thresholdMs = 200, limit = 20, includeInitiators = true } = {}
) {
  const requestEntries = networkEntries.filter((e) => e && (e.kind === 'request' || !e.kind) && e.url);
  const totalAnalyzed = requestEntries.length;

  // 1. Slowest Requests
  const slowCandidates = requestEntries.filter(
    (e) => typeof e.durationMs === 'number' && e.durationMs >= thresholdMs
  );
  slowCandidates.sort((a, b) => b.durationMs - a.durationMs);

  const slowestRequests = slowCandidates.slice(0, limit).map((e) => {
    const initiatorStr = includeInitiators ? summarizeInitiator(e.initiator) : null;
    return {
      url: e.url,
      method: e.method || 'GET',
      durationMs: e.durationMs,
      status: e.status ?? null,
      type: e.type ?? null,
      initiator: initiatorStr,
      initiatorSummary: initiatorStr
    };
  });

  // 2. Endpoint Latency Stats (P50, P90, P99, avgMs, maxMs per normalized pattern)
  const endpointGroups = new Map();
  for (const e of requestEntries) {
    if (typeof e.durationMs !== 'number') continue;
    const pattern = normalizeEndpoint(e.url);
    let group = endpointGroups.get(pattern);
    if (!group) {
      group = { durations: [], totalDuration: 0 };
      endpointGroups.set(pattern, group);
    }
    group.durations.push(e.durationMs);
    group.totalDuration += e.durationMs;
  }

  const endpointLatencyStats = [];
  for (const [endpoint, group] of endpointGroups) {
    group.durations.sort((a, b) => a - b);
    const count = group.durations.length;
    const avgMs = Math.round((group.totalDuration / count) * 10) / 10;
    const maxMs = group.durations[count - 1];
    const statItem = {
      endpoint,
      count,
      p50: calcPercentile(group.durations, 50),
      p90: calcPercentile(group.durations, 90),
      p99: calcPercentile(group.durations, 99),
      avgMs,
      maxMs
    };
    endpointLatencyStats.push(statItem);
    endpointLatencyStats[endpoint] = statItem;
  }

  endpointLatencyStats.sort((a, b) => b.p90 - a.p90 || b.count - a.count);

  // 3. Failed Asset Loads (status >= 400 or failed: true)
  const failedMap = new Map();
  for (const e of requestEntries) {
    const isHttpError = typeof e.status === 'number' && e.status >= 400;
    const isNetworkFailure = e.failed === true;
    if (!isHttpError && !isNetworkFailure) continue;

    const key = `${e.method || 'GET'} ${e.url} ${e.status ?? 'failed'}`;
    let item = failedMap.get(key);
    if (!item) {
      item = {
        url: e.url,
        method: e.method || 'GET',
        type: e.type ?? null,
        status: e.status ?? null,
        failed: isNetworkFailure,
        errorText: e.errorText ?? null,
        count: 0,
        initiator: includeInitiators ? summarizeInitiator(e.initiator) : null
      };
      failedMap.set(key, item);
    }
    item.count += 1;
    if (e.errorText && !item.errorText) {
      item.errorText = e.errorText;
    }
  }

  const failedAssets = [...failedMap.values()].sort((a, b) => b.count - a.count || a.url.localeCompare(b.url));

  // 4. Concise Summary
  let summary = '';
  if (totalAnalyzed === 0) {
    summary = 'Analyzed 0 network requests. No slow requests or bottlenecks detected.';
  } else {
    const slowCount = slowCandidates.length;
    const failedCount = failedAssets.reduce((sum, f) => sum + f.count, 0);
    const worstStr =
      slowestRequests.length > 0
        ? ` (worst: ${slowestRequests[0].method} ${slowestRequests[0].url} took ${slowestRequests[0].durationMs}ms)`
        : '';
    const failedStr =
      failedCount > 0
        ? ` ${failedCount} failed asset load${failedCount === 1 ? '' : 's'}.`
        : '';
    summary = `Analyzed ${totalAnalyzed} network requests: ${slowCount} slow request${slowCount === 1 ? '' : 's'} exceeding ${thresholdMs}ms threshold${worstStr}.${failedStr}`;
  }

  return {
    slowestRequests,
    endpointLatencyStats,
    failedAssets,
    summary
  };
}
