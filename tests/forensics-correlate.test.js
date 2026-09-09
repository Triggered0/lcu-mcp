import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  correlateTimelines,
  formatNarrativeLine,
  normalizeWampEntry,
  normalizeCdpEntry
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
    wampCount: 3,
    cdpCount: 2,
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
    wampCount: 0,
    cdpCount: 0,
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

