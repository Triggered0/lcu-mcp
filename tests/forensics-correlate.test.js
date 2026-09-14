import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  correlateTimelines,
  formatNarrativeLine,
  normalizeWampEntry,
  normalizeCdpEntry,
  normalizeNetworkEntry,
  normalizeLogEntry,
  normalizeGameEntry
} from '../src/forensics/correlate.js';

test('normalizeWampEntry normalizes event with uri and payload', () => {
  const entry = {
    ts: 1000,
    wallTs: 1_700_000_000_000,
    kind: 'event',
    uri: '/lol-gameflow/v1/gameflow-phase',
    data: 'ChampSelect'
  };
  const normalized = normalizeWampEntry(entry);
  assert.equal(normalized.source, 'wamp');
  assert.equal(normalized.ts, 1000);
  assert.equal(normalized.wallTs, 1_700_000_000_000);
  assert.equal(normalized.kind, 'event');
  assert.equal(normalized.summary, '/lol-gameflow/v1/gameflow-phase -> "ChampSelect"');
});

test('normalizeWampEntry handles null or undefined data', () => {
  const entry = {
    ts: 1000,
    wallTs: 1_700_000_000_000,
    kind: 'event',
    uri: '/lol-champ-select/v1/session',
    data: null
  };
  const normalized = normalizeWampEntry(entry);
  assert.equal(normalized.summary, '/lol-champ-select/v1/session -> null');
});

test('normalizeWampEntry caps long event payload to ~120 chars', () => {
  const entry = {
    ts: 1000,
    wallTs: 1_700_000_000_000,
    kind: 'event',
    uri: '/lol-matchmaking/v1/search',
    data: { huge: 'a'.repeat(300) }
  };
  const normalized = normalizeWampEntry(entry);
  assert.ok(normalized.summary.length <= 120);
  assert.ok(normalized.summary.endsWith('...'));
  assert.ok(normalized.summary.startsWith('/lol-matchmaking/v1/search -> '));
});

test('normalizeWampEntry normalizes lifecycle entries', () => {
  const start = normalizeWampEntry({ ts: 10, wallTs: 100, kind: 'start' });
  assert.equal(start.kind, 'start');
  assert.equal(start.summary, '[start]');

  const close = normalizeWampEntry({ ts: 20, wallTs: 110, kind: 'close', reason: 'socket hang up' });
  assert.equal(close.kind, 'close');
  assert.equal(close.summary, '[close] socket hang up');

  const error = normalizeWampEntry({ ts: 30, wallTs: 120, kind: 'error', message: 'ECONNREFUSED' });
  assert.equal(error.kind, 'error');
  assert.equal(error.summary, '[error] ECONNREFUSED');

  const stop = normalizeWampEntry({ ts: 40, wallTs: 130, kind: 'stop', reason: 'user requested' });
  assert.equal(stop.kind, 'stop');
  assert.equal(stop.summary, '[stop] user requested');

  const reconnect = normalizeWampEntry({ ts: 50, wallTs: 140, kind: 'reconnect' });
  assert.equal(reconnect.kind, 'reconnect');
  assert.equal(reconnect.summary, '[reconnect]');
});

test('normalizeCdpEntry normalizes console log entry with text or args', () => {
  const withText = normalizeCdpEntry({
    ts: 1000,
    wallTs: 1_700_000_000_000,
    kind: 'console',
    level: 'info',
    text: 'Client initialized'
  });
  assert.equal(withText.source, 'cdp');
  assert.equal(withText.kind, 'console');
  assert.equal(withText.level, 'info');
  assert.equal(withText.summary, '[info] Client initialized');

  const withArgs = normalizeCdpEntry({
    ts: 1001,
    wallTs: 1_700_000_000_001,
    kind: 'console',
    level: 'warn',
    args: 'Deprecated feature used'
  });
  assert.equal(withArgs.source, 'cdp');
  assert.equal(withArgs.level, 'warn');
  assert.equal(withArgs.summary, '[warn] Deprecated feature used');
});

test('normalizeCdpEntry defaults kind to console and level to log', () => {
  const entry = normalizeCdpEntry({
    ts: 1000,
    wallTs: 1_700_000_000_000,
    text: 'Simple message'
  });
  assert.equal(entry.kind, 'console');
  assert.equal(entry.level, 'log');
  assert.equal(entry.summary, '[log] Simple message');
});

test('normalizeCdpEntry normalizes exception entry', () => {
  const ex = normalizeCdpEntry({
    ts: 1000,
    wallTs: 1_700_000_000_000,
    kind: 'exception',
    text: 'TypeError: Cannot read properties of undefined'
  });
  assert.equal(ex.kind, 'exception');
  assert.equal(ex.level, 'error');
  assert.equal(ex.summary, 'TypeError: Cannot read properties of undefined');

  const exWithDesc = normalizeCdpEntry({
    ts: 1001,
    wallTs: 1_700_000_000_001,
    kind: 'exception',
    text: 'Uncaught',
    description: 'ReferenceError: foo is not defined'
  });
  assert.equal(exWithDesc.summary, 'ReferenceError: foo is not defined');

  const exFallback = normalizeCdpEntry({
    ts: 1002,
    wallTs: 1_700_000_000_002,
    kind: 'exception'
  });
  assert.equal(exFallback.summary, 'Exception');
});

test('normalizeCdpEntry normalizes reattach lifecycle entry', () => {
  const reattach = normalizeCdpEntry({
    ts: 1000,
    wallTs: 1_700_000_000_000,
    kind: 'reattach',
    targetId: 'PAGE-2'
  });
  assert.equal(reattach.kind, 'reattach');
  assert.equal(reattach.summary, '[reattach]');
});

test('formatNarrativeLine formats entries with timestamp, source, kind, and summary', () => {
  const wampEntry = {
    source: 'wamp',
    kind: 'event',
    wallTs: Date.parse('2026-09-08T18:14:02.100Z'),
    summary: '/lol-gameflow/v1/gameflow-phase -> "ChampSelect"'
  };
  assert.equal(
    formatNarrativeLine(wampEntry),
    '[18:14:02.100] [WAMP:event] /lol-gameflow/v1/gameflow-phase -> "ChampSelect"'
  );

  const cdpEntry = {
    source: 'cdp',
    kind: 'exception',
    wallTs: Date.parse('2026-09-08T18:14:02.105Z'),
    summary: 'TypeError: Cannot read properties of undefined'
  };
  assert.equal(
    formatNarrativeLine(cdpEntry),
    '[18:14:02.105] [CDP:exception] TypeError: Cannot read properties of undefined'
  );
});

test('formatNarrativeLine handles un-normalized entries and missing timestamp gracefully', () => {
  const line = formatNarrativeLine({
    kind: 'event',
    uri: '/endpoint',
    data: 123
  });
  assert.ok(line.includes('[WAMP:event] /endpoint -> 123'));
  assert.ok(line.startsWith('[00:00:00.000]'));
});

test('correlateTimelines interleaves WAMP and CDP entries strictly by timestamp', () => {
  const wampEntries = [
    { ts: 10, wallTs: Date.parse('2026-09-08T10:00:00.010Z'), kind: 'event', uri: '/uri1', data: 'first' },
    { ts: 30, wallTs: Date.parse('2026-09-08T10:00:00.030Z'), kind: 'event', uri: '/uri2', data: 'third' }
  ];
  const cdpEntries = [
    { ts: 20, wallTs: Date.parse('2026-09-08T10:00:00.020Z'), kind: 'console', level: 'info', text: 'second' }
  ];

  const result = correlateTimelines({ wampEntries, cdpEntries, format: 'events' });
  assert.equal(result.length, 3);
  assert.equal(result[0].ts, 10);
  assert.equal(result[0].source, 'wamp');
  assert.equal(result[1].ts, 20);
  assert.equal(result[1].source, 'cdp');
  assert.equal(result[2].ts, 30);
  assert.equal(result[2].source, 'wamp');
});

test('correlateTimelines falls back to wallTs when ts is missing', () => {
  const wampEntries = [{ wallTs: 200, kind: 'event', uri: '/b', data: 2 }];
  const cdpEntries = [{ wallTs: 100, kind: 'console', text: 'a' }];

  const result = correlateTimelines({ wampEntries, cdpEntries, format: 'events' });
  assert.equal(result[0].source, 'cdp');
  assert.equal(result[1].source, 'wamp');
});

test('correlateTimelines handles empty entries on either or both sides', () => {
  const emptyBoth = correlateTimelines({ wampEntries: [], cdpEntries: [], format: 'events' });
  assert.deepEqual(emptyBoth, []);

  const emptyCdp = correlateTimelines({
    wampEntries: [{ ts: 1, wallTs: 1, kind: 'start' }],
    cdpEntries: [],
    format: 'events'
  });
  assert.equal(emptyCdp.length, 1);
  assert.equal(emptyCdp[0].source, 'wamp');

  const emptyWamp = correlateTimelines({
    wampEntries: [],
    cdpEntries: [{ ts: 1, wallTs: 1, kind: 'console', text: 'hello' }],
    format: 'events'
  });
  assert.equal(emptyWamp.length, 1);
  assert.equal(emptyWamp[0].source, 'cdp');
});

test('correlateTimelines slices to limit', () => {
  const wampEntries = [
    { ts: 1, wallTs: 1, kind: 'event', uri: '/1', data: 1 },
    { ts: 3, wallTs: 3, kind: 'event', uri: '/3', data: 3 }
  ];
  const cdpEntries = [
    { ts: 2, wallTs: 2, kind: 'console', text: '2' },
    { ts: 4, wallTs: 4, kind: 'console', text: '4' }
  ];

  const result = correlateTimelines({ wampEntries, cdpEntries, limit: 2, format: 'events' });
  assert.equal(result.length, 2);
  assert.equal(result[0].ts, 1);
  assert.equal(result[1].ts, 2);
});

test('correlateTimelines narrative format produces header and lines', () => {
  const wampEntries = [
    { ts: 100, wallTs: Date.parse('2026-09-08T18:14:02.100Z'), kind: 'event', uri: '/lol-gameflow/v1/gameflow-phase', data: 'ChampSelect' }
  ];
  const cdpEntries = [
    { ts: 105, wallTs: Date.parse('2026-09-08T18:14:02.105Z'), kind: 'exception', text: 'TypeError: boom' }
  ];

  const narrative = correlateTimelines({ wampEntries, cdpEntries, format: 'narrative' });
  const lines = narrative.split('\n');
  assert.equal(lines[0], '=== CORRELATED FORENSICS TIMELINE (2 events) ===');
  assert.equal(lines[1], '[18:14:02.100] [WAMP:event] /lol-gameflow/v1/gameflow-phase -> "ChampSelect"');
  assert.equal(lines[2], '[18:14:02.105] [CDP:exception] TypeError: boom');
});

test('correlateTimelines narrative format on empty lists produces header only', () => {
  const narrative = correlateTimelines({ wampEntries: [], cdpEntries: [], format: 'narrative' });
  assert.equal(narrative, '=== CORRELATED FORENSICS TIMELINE (0 events) ===');
});

test('correlateTimelines summary format computes accurate statistics', () => {
  const wampEntries = [
    { ts: 100, wallTs: 100, kind: 'start' },
    { ts: 200, wallTs: 200, kind: 'event', uri: '/test', data: 'ok' },
    { ts: 400, wallTs: 400, kind: 'error', message: 'connection dropped' }
  ];
  const cdpEntries = [
    { ts: 150, wallTs: 150, kind: 'console', level: 'info', text: 'ok' },
    { ts: 300, wallTs: 300, kind: 'exception', text: 'Uncaught Error' }
  ];

  const summary = correlateTimelines({ wampEntries, cdpEntries, format: 'summary' });
  assert.deepEqual(summary, {
    total: 5,
    sources: {
      wamp: 3,
      cdp: 2,
      network: 0,
      logs: 0,
      game: 0
    },
    errorCount: 2,
    timeSpanMs: 300,
    firstTs: 100,
    lastTs: 400
  });
});

test('correlateTimelines summary format on empty input returns zeros', () => {
  const summary = correlateTimelines({ wampEntries: [], cdpEntries: [], format: 'summary' });
  assert.deepEqual(summary, {
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
  });
});

test('correlateTimelines filters cdp entries by levels', () => {
  const wampEntries = [
    { ts: 10, wallTs: 10, kind: 'event', uri: '/test', data: 'ok' }
  ];
  const cdpEntries = [
    { ts: 20, wallTs: 20, kind: 'console', level: 'info', text: 'info msg' },
    { ts: 30, wallTs: 30, kind: 'console', level: 'error', text: 'error msg' },
    { ts: 40, wallTs: 40, kind: 'reattach' }
  ];

  const result = correlateTimelines({
    wampEntries,
    cdpEntries,
    levels: ['error'],
    format: 'events'
  });

  assert.equal(result.length, 3);
  assert.equal(result[0].source, 'wamp');
  assert.equal(result[1].summary, '[error] error msg');
  assert.equal(result[2].kind, 'reattach');
});

test('normalizeNetworkEntry normalizes request with method, url, status, and durationMs', () => {
  const entry = {
    ts: 1000,
    startedAt: 1_700_000_000_000,
    method: 'GET',
    url: '/lol-champ-select/v1/session',
    status: 200,
    durationMs: 15
  };
  const normalized = normalizeNetworkEntry(entry);
  assert.equal(normalized.source, 'network');
  assert.equal(normalized.ts, 1000);
  assert.equal(normalized.wallTs, 1_700_000_000_000);
  assert.equal(normalized.kind, 'request');
  assert.equal(normalized.status, 200);
  assert.equal(normalized.failed, false);
  assert.equal(normalized.isError, false);
  assert.equal(normalized.summary, 'GET /lol-champ-select/v1/session -> 200 (15ms)');
});

test('normalizeNetworkEntry marks 4xx, 5xx, and failed requests as errors', () => {
  const err404 = normalizeNetworkEntry({
    method: 'GET',
    url: '/missing',
    status: 404,
    durationMs: 5
  });
  assert.equal(err404.isError, true);
  assert.equal(err404.summary, 'GET /missing -> 404 (5ms)');

  const failedReq = normalizeNetworkEntry({
    method: 'POST',
    url: '/lol-login/v1/session',
    failed: true,
    errorText: 'net::ERR_CONNECTION_REFUSED'
  });
  assert.equal(failedReq.isError, true);
  assert.equal(failedReq.failed, true);
  assert.equal(failedReq.summary, 'POST /lol-login/v1/session -> failed [net::ERR_CONNECTION_REFUSED]');
});

test('normalizeNetworkEntry normalizes reattach and other lifecycle entries', () => {
  const reattachWithGap = normalizeNetworkEntry({
    kind: 'reattach',
    targetId: 'PAGE-2',
    gapMs: 150
  });
  assert.equal(reattachWithGap.kind, 'reattach');
  assert.equal(reattachWithGap.summary, '[reattach] Target PAGE-2 after 150ms');

  const reattachNoGap = normalizeNetworkEntry({
    kind: 'reattach',
    targetId: 'PAGE-3'
  });
  assert.equal(reattachNoGap.summary, '[reattach] Target PAGE-3');

  const otherKind = normalizeNetworkEntry({
    kind: 'custom',
    url: '/other'
  });
  assert.equal(otherKind.summary, '[custom] /other');
});

test('normalizeLogEntry normalizes standard client log entry', () => {
  const entry = {
    target: 'client',
    level: 'ERROR',
    message: 'Failed to initialize renderer',
    wallTime: 1_700_000_000_500
  };
  const normalized = normalizeLogEntry(entry);
  assert.equal(normalized.source, 'logs');
  assert.equal(normalized.kind, 'log');
  assert.equal(normalized.target, 'client');
  assert.equal(normalized.level, 'ERROR');
  assert.equal(normalized.wallTs, 1_700_000_000_500);
  assert.equal(normalized.summary, '[client:ERROR] Failed to initialize renderer');
  assert.equal(normalized.isError, true);
});

test('normalizeLogEntry evaluates ALWAYS level error patterns', () => {
  const fatalAlways = normalizeLogEntry({
    target: 'ux',
    level: 'ALWAYS',
    message: 'Fatal assertion failed at line 42'
  });
  assert.equal(fatalAlways.isError, true);

  const cleanAlways = normalizeLogEntry({
    target: 'ux',
    level: 'ALWAYS',
    message: 'Command Line: --app-port=1234'
  });
  assert.equal(cleanAlways.isError, false);
});

test('normalizeLogEntry falls back to raw when message is absent', () => {
  const entry = {
    target: 'game',
    level: 'WARN',
    raw: 'Shader compile warning'
  };
  const normalized = normalizeLogEntry(entry);
  assert.equal(normalized.summary, '[game:WARN] Shader compile warning');
  assert.equal(normalized.isError, false);
});

test('normalizeGameEntry normalizes ChampionKill with killer, victim, and event time', () => {
  const entry = {
    EventID: 2,
    EventName: 'ChampionKill',
    EventTime: 180.2,
    KillerName: 'Faker',
    VictimName: 'Chovy',
    wallTs: 1_700_000_180_200
  };
  const normalized = normalizeGameEntry(entry);
  assert.equal(normalized.source, 'game');
  assert.equal(normalized.kind, 'ChampionKill');
  assert.equal(normalized.wallTs, 1_700_000_180_200);
  assert.equal(normalized.summary, 'ChampionKill @ 180.2s: Faker killed Chovy');
  assert.equal(normalized.isError, false);
});

test('normalizeGameEntry normalizes objective and game lifecycle events', () => {
  const start = normalizeGameEntry({
    EventName: 'GameStart',
    EventTime: 0.1
  });
  assert.equal(start.summary, 'GameStart @ 0.1s');

  const objective = normalizeGameEntry({
    EventName: 'DragonKill',
    EventTime: 700,
    KillerName: 'PlayerOne',
    Recipient: 'ORDER'
  });
  assert.equal(objective.summary, 'DragonKill @ 700s: PlayerOne (ORDER)');

  const end = normalizeGameEntry({
    EventName: 'GameEnd',
    Result: 'Win'
  });
  assert.equal(end.summary, 'GameEnd: Win');
});

test('formatNarrativeLine formats entries across all five streams', () => {
  const wallTs = Date.parse('2026-09-08T18:14:02.100Z');
  const wampLine = formatNarrativeLine({ source: 'wamp', wallTs, kind: 'event', summary: '/uri -> "ok"' });
  assert.equal(wampLine, '[18:14:02.100] [WAMP:event] /uri -> "ok"');

  const cdpLine = formatNarrativeLine({ source: 'cdp', wallTs, kind: 'console', summary: '[error] Boom' });
  assert.equal(cdpLine, '[18:14:02.100] [CDP:console] [error] Boom');

  const netLine = formatNarrativeLine({ source: 'network', wallTs, kind: 'request', summary: 'GET /api -> 200 (10ms)' });
  assert.equal(netLine, '[18:14:02.100] [NETWORK:request] GET /api -> 200 (10ms)');

  const logLine = formatNarrativeLine({ source: 'logs', wallTs, kind: 'log', summary: '[client:ERROR] Fail' });
  assert.equal(logLine, '[18:14:02.100] [LOGS:log] [client:ERROR] Fail');

  const gameLine = formatNarrativeLine({ source: 'game', wallTs, kind: 'ChampionKill', summary: 'ChampionKill @ 180.2s: Faker killed Chovy' });
  assert.equal(gameLine, '[18:14:02.100] [GAME:ChampionKill] ChampionKill @ 180.2s: Faker killed Chovy');
});

test('formatNarrativeLine auto-dispatches un-normalized entries for network, logs, and game', () => {
  const netLine = formatNarrativeLine({
    method: 'GET',
    url: '/lol-gameflow/v1/session',
    status: 200,
    wallTs: Date.parse('2026-09-08T18:14:02.100Z')
  });
  assert.ok(netLine.includes('[NETWORK:request] GET /lol-gameflow/v1/session -> 200'));

  const logLine = formatNarrativeLine({
    target: 'ux',
    level: 'ERROR',
    message: 'CEF crashed',
    wallTime: Date.parse('2026-09-08T18:14:02.105Z')
  });
  assert.ok(logLine.includes('[LOGS:log] [ux:ERROR] CEF crashed'));

  const gameLine = formatNarrativeLine({
    EventName: 'GameStart',
    EventTime: 0.1,
    wallTs: Date.parse('2026-09-08T18:14:02.110Z')
  });
  assert.ok(gameLine.includes('[GAME:GameStart] GameStart @ 0.1s'));
});

test('correlateTimelines merges entries from all five streams in correct chronological order', () => {
  const wampEntries = [{ wallTs: 10, kind: 'event', uri: '/wamp', data: 1 }];
  const cdpEntries = [{ wallTs: 30, kind: 'console', text: 'cdp' }];
  const networkEntries = [{ wallTs: 20, method: 'GET', url: '/net', status: 200 }];
  const logEntries = [{ wallTime: 50, target: 'client', level: 'INFO', message: 'log' }];
  const gameEntries = [{ wallTs: 40, EventName: 'GameStart', EventTime: 0 }];

  const result = correlateTimelines({
    wampEntries,
    cdpEntries,
    networkEntries,
    logEntries,
    gameEntries,
    format: 'events'
  });

  assert.equal(result.length, 5);
  assert.equal(result[0].source, 'wamp');
  assert.equal(result[1].source, 'network');
  assert.equal(result[2].source, 'cdp');
  assert.equal(result[3].source, 'game');
  assert.equal(result[4].source, 'logs');
});

test('correlateTimelines filters by sources array or Set', () => {
  const wampEntries = [{ wallTs: 10, kind: 'event', uri: '/wamp', data: 1 }];
  const networkEntries = [{ wallTs: 20, method: 'GET', url: '/net', status: 200 }];
  const logEntries = [{ wallTime: 30, target: 'client', level: 'INFO', message: 'log' }];

  const filtered = correlateTimelines({
    wampEntries,
    networkEntries,
    logEntries,
    sources: ['network', 'logs'],
    format: 'events'
  });

  assert.equal(filtered.length, 2);
  assert.equal(filtered[0].source, 'network');
  assert.equal(filtered[1].source, 'logs');

  const filteredSet = correlateTimelines({
    wampEntries,
    networkEntries,
    logEntries,
    sources: new Set(['wamp']),
    format: 'events'
  });

  assert.equal(filteredSet.length, 1);
  assert.equal(filteredSet[0].source, 'wamp');
});

test('correlateTimelines summary format computes accurate statistics across all five streams', () => {
  const wampEntries = [
    { wallTs: 100, kind: 'start' },
    { wallTs: 500, kind: 'error', message: 'conn dropped' }
  ];
  const cdpEntries = [
    { wallTs: 200, kind: 'exception', text: 'TypeError' }
  ];
  const networkEntries = [
    { wallTs: 300, method: 'GET', url: '/net', status: 200 },
    { wallTs: 400, method: 'POST', url: '/fail', failed: true }
  ];
  const logEntries = [
    { wallTime: 250, target: 'client', level: 'ERROR', message: 'crash' },
    { wallTime: 260, target: 'client', level: 'INFO', message: 'ok' }
  ];
  const gameEntries = [
    { wallTs: 450, EventName: 'ChampionKill', EventTime: 10, KillerName: 'A', VictimName: 'B' }
  ];

  const summary = correlateTimelines({
    wampEntries,
    cdpEntries,
    networkEntries,
    logEntries,
    gameEntries,
    format: 'summary'
  });

  assert.deepEqual(summary, {
    total: 8,
    sources: {
      wamp: 2,
      cdp: 1,
      network: 2,
      logs: 2,
      game: 1
    },
    errorCount: 4,
    timeSpanMs: 400,
    firstTs: 100,
    lastTs: 500
  });
});

test('correlateTimelines filters by comma-separated sources string', () => {
  const wampEntries = [{ wallTs: 10, kind: 'event', uri: '/wamp', data: 1 }];
  const networkEntries = [{ wallTs: 20, method: 'GET', url: '/net', status: 200 }];
  const logEntries = [{ wallTime: 30, target: 'client', level: 'INFO', message: 'log' }];

  const filtered = correlateTimelines({
    wampEntries,
    networkEntries,
    logEntries,
    sources: 'network, logs',
    format: 'events'
  });

  assert.equal(filtered.length, 2);
  assert.equal(filtered[0].source, 'network');
  assert.equal(filtered[1].source, 'logs');
});

test('formatNarrativeLine disambiguates unnormalized entries with targetId or durationMs', () => {
  const netWithDuration = formatNarrativeLine({
    url: '/test-endpoint',
    durationMs: 45,
    wallTs: 1000
  });
  assert.ok(netWithDuration.includes('[NETWORK:request]'));
  assert.ok(netWithDuration.includes('(45ms)'));

  const cdpWithTargetId = formatNarrativeLine({
    targetId: 'TARGET-PAGE-1',
    args: 'Console message',
    wallTs: 1001
  });
  assert.ok(cdpWithTargetId.includes('[CDP:console]'));
  assert.ok(cdpWithTargetId.includes('Console message'));

  const cdpBareTargetId = formatNarrativeLine({
    targetId: 'TARGET-PAGE-2',
    wallTs: 1002
  });
  assert.ok(cdpBareTargetId.includes('[CDP:console]'));
});



