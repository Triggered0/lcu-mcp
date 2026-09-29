/**
 * Cross-Stream Anomaly & Crash Pattern Detection Engine.
 *
 * Scans across LCU WAMP events, Chrome DevTools Protocol console logs,
 * CDP network requests, and disk logs to detect crashes, disconnects,
 * HTTP error clusters, and frontend exception bursts.
 */

function getEntryTimestamp(entry) {
  if (!entry) return null;
  const raw = entry.wallTs ?? entry.ts ?? entry.wallTime ?? entry.startedAt ?? entry.pageTs;
  if (typeof raw === 'number' && !Number.isNaN(raw)) return raw;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

export function detectAnomalies({
  wampEntries = [],
  cdpEntries = [],
  networkEntries = [],
  logEntries = [],
  windowMs = 60000
} = {}) {
  const allEntries = [...wampEntries, ...cdpEntries, ...networkEntries, ...logEntries];
  let maxTs = -Infinity;
  for (const e of allEntries) {
    const ts = getEntryTimestamp(e);
    if (ts !== null && ts > maxTs) {
      maxTs = ts;
    }
  }

  let filteredWamp = wampEntries;
  let filteredCdp = cdpEntries;
  let filteredNetwork = networkEntries;
  let filteredLogs = logEntries;

  if (windowMs && windowMs > 0 && maxTs !== -Infinity) {
    const cutoff = maxTs - windowMs;
    const filterByWindow = (arr) =>
      arr.filter((e) => {
        const ts = getEntryTimestamp(e);
        return ts === null || ts >= cutoff;
      });
    filteredWamp = filterByWindow(wampEntries);
    filteredCdp = filterByWindow(cdpEntries);
    filteredNetwork = filterByWindow(networkEntries);
    filteredLogs = filterByWindow(logEntries);
  }

  const anomalies = [];

  // 1. Detect Frontend Exception Bursts (5+ errors in 10s)
  const cdpErrors = [];
  for (const entry of filteredCdp) {
    const isException = entry.kind === 'exception';
    const isConsoleError =
      entry.kind === 'console' && (entry.level === 'error' || entry.type === 'error');
    const isGenericError =
      entry.level === 'error' || entry.isError === true;
    if (isException || isConsoleError || isGenericError) {
      cdpErrors.push({
        entry,
        ts: getEntryTimestamp(entry) ?? (maxTs !== -Infinity ? maxTs : 0)
      });
    }
  }
  cdpErrors.sort((a, b) => a.ts - b.ts);

  const BURST_WINDOW_MS = 10000;
  const BURST_MIN_COUNT = 5;

  let i = 0;
  while (i < cdpErrors.length) {
    let j = i;
    while (j < cdpErrors.length && cdpErrors[j].ts - cdpErrors[i].ts <= BURST_WINDOW_MS) {
      j++;
    }
    const count = j - i;
    if (count >= BURST_MIN_COUNT) {
      const burstSlice = cdpErrors.slice(i, j);
      const firstTs = burstSlice[0].ts;
      const lastTs = burstSlice[count - 1].ts;
      const durationSec = Math.round(((lastTs - firstTs) / 1000) * 10) / 10;
      anomalies.push({
        type: 'FRONTEND_EXCEPTION_BURST',
        severity: 'DEGRADED',
        timestamp: firstTs,
        description: `Frontend exception burst: ${count} console errors/exceptions detected within ${durationSec}s`,
        details: {
          count,
          timeSpanMs: lastTs - firstTs,
          sampleErrors: burstSlice
            .slice(0, 5)
            .map((b) => b.entry.text || b.entry.description || b.entry.args || 'Error')
        }
      });
      i = j;
    } else {
      i++;
    }
  }

  // 2. Detect LCU HTTP Error Clusters (consecutive 500 or 503 responses)
  const httpRequests = [];
  for (const entry of filteredNetwork) {
    if (entry.kind === 'request' || entry.status !== undefined || entry.url) {
      httpRequests.push({
        entry,
        ts: getEntryTimestamp(entry) ?? (maxTs !== -Infinity ? maxTs : 0),
        status: entry.status,
        failed: Boolean(entry.failed)
      });
    }
  }
  httpRequests.sort((a, b) => a.ts - b.ts);

  function record5xxCluster(cluster) {
    const firstTs = cluster[0].ts;
    const count = cluster.length;
    const statusCodes = cluster.map((c) => c.status);
    const urls = [...new Set(cluster.map((c) => c.entry.url).filter(Boolean))];
    anomalies.push({
      type: 'HTTP_ERROR_CLUSTER',
      severity: 'CRITICAL',
      timestamp: firstTs,
      description: `LCU HTTP error cluster: ${count} consecutive ${statusCodes.join(', ')} server error responses`,
      details: {
        count,
        statusCodes,
        urls,
        errors: cluster.slice(0, 5).map((c) => ({
          url: c.entry.url,
          status: c.status,
          method: c.entry.method
        }))
      }
    });
  }

  let current5xxCluster = [];
  for (let idx = 0; idx < httpRequests.length; idx++) {
    const req = httpRequests[idx];
    const is5xx = typeof req.status === 'number' && req.status >= 500;
    if (is5xx) {
      current5xxCluster.push(req);
    } else {
      if (current5xxCluster.length >= 2) {
        record5xxCluster(current5xxCluster);
      }
      current5xxCluster = [];
    }
  }
  if (current5xxCluster.length >= 2) {
    record5xxCluster(current5xxCluster);
  }

  // 3. Detect WebSocket / WAMP Disconnect Events
  for (const entry of filteredWamp) {
    const isClose = entry.kind === 'close';
    const isError = entry.kind === 'error';
    const isGap = entry.kind === 'gap';

    if (isClose || isError || isGap) {
      const ts = getEntryTimestamp(entry) ?? (maxTs !== -Infinity ? maxTs : 0);
      const isUnclean =
        entry.wasClean === false || (typeof entry.code === 'number' && entry.code !== 1000);
      const severity = isClose && !isUnclean ? 'DEGRADED' : 'CRITICAL';
      const reason =
        entry.reason ||
        entry.message ||
        (isGap ? `Connection gap of ${entry.durationMs}ms` : 'Connection closed');

      anomalies.push({
        type: 'WAMP_DISCONNECT',
        severity,
        timestamp: ts,
        description: `LCU WAMP WebSocket disconnected: ${reason}`,
        details: {
          kind: entry.kind,
          code: entry.code ?? null,
          reason: entry.reason ?? '',
          wasClean: entry.wasClean ?? entry.code === 1000,
          message: entry.message ?? null,
          durationMs: entry.durationMs ?? null
        }
      });
    }
  }

  // 4. Detect Client Disk Logs Fatal / Crash Errors
  for (const entry of filteredLogs) {
    const level = (entry.level || '').toUpperCase();
    const msg = entry.message || entry.raw || '';
    const isFatalOrCrash = level === 'FATAL' || /crash|fatal|segfault|access violation/i.test(msg);
    if (isFatalOrCrash) {
      const ts = getEntryTimestamp(entry) ?? (maxTs !== -Infinity ? maxTs : 0);
      anomalies.push({
        type: 'CLIENT_CRASH',
        severity: 'CRITICAL',
        timestamp: ts,
        description: `Client process logged fatal crash signature: ${msg}`,
        details: {
          target: entry.target || 'client',
          level,
          line: msg
        }
      });
    }
  }

  // Calculate composite health verdict
  let verdict = 'HEALTHY';
  if (anomalies.some((a) => a.severity === 'CRITICAL')) {
    verdict = 'CRITICAL';
  } else if (anomalies.length > 0) {
    verdict = 'DEGRADED';
  }

  // Formulate root-cause hypotheses
  const hypotheses = [];
  const hasWampDisconnect = anomalies.some((a) => a.type === 'WAMP_DISCONNECT');
  const hasHttpCluster = anomalies.some((a) => a.type === 'HTTP_ERROR_CLUSTER');
  const hasFrontendBurst = anomalies.some((a) => a.type === 'FRONTEND_EXCEPTION_BURST');
  const hasClientCrash = anomalies.some((a) => a.type === 'CLIENT_CRASH');

  if (hasWampDisconnect && hasHttpCluster) {
    hypotheses.push(
      'LCU backend process crash or restart: WAMP WebSocket dropped concurrently with HTTP 5xx server errors.'
    );
  } else if (hasWampDisconnect) {
    hypotheses.push(
      'LCU WebSocket connection dropped; may indicate client restart, UX reload, or port invalidation.'
    );
  }

  if (hasHttpCluster && !hasWampDisconnect) {
    hypotheses.push(
      'LCU backend internal server error (500/503): Riot Client or LeagueClientUx backend is failing internal RPCs or encountering lockfile/auth issues.'
    );
  }

  if (hasFrontendBurst) {
    if (
      hasHttpCluster ||
      filteredNetwork.some((e) => (typeof e.status === 'number' && e.status >= 400) || e.failed)
    ) {
      hypotheses.push(
        'Frontend JavaScript exceptions triggered by failing backend network requests or unexpected API payload responses.'
      );
    } else {
      hypotheses.push(
        'Frontend UI plugin or component encountered rapid unhandled exceptions. Potential UI freeze or broken plugin script.'
      );
    }
  }

  if (hasClientCrash) {
    hypotheses.push(
      'League client process encountered a fatal crash or segmentation fault documented in disk logs.'
    );
  }

  let summary = '';
  if (verdict === 'HEALTHY') {
    summary = 'System healthy. No cross-stream anomalies detected within the analysis window.';
  } else {
    const criticalCount = anomalies.filter((a) => a.severity === 'CRITICAL').length;
    const degradedCount = anomalies.filter((a) => a.severity === 'DEGRADED').length;
    summary = `System ${verdict.toLowerCase()}: ${anomalies.length} anomal${anomalies.length === 1 ? 'y' : 'ies'} detected (${criticalCount} critical, ${degradedCount} degraded).`;
  }

  return {
    verdict,
    summary,
    anomalies,
    hypotheses
  };
}
