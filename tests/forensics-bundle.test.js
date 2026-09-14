import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createForensicsBundle } from '../src/forensics/bundle.js';

function createMockContext(overrides = {}) {
  let logReaderCalled = false;
  return {
    lcu: {
      isConnected: () => true,
      port: 29669,
      pid: 1234
    },
    cdp: {
      statusSnapshot: () => ({ running: true, attached: true, targetId: 'page-1' })
    },
    gameClient: {
      isGameRunning: async () => true,
      getEvents: async () => ({
        Events: [
          {
            EventID: 1,
            EventName: 'ChampionKill',
            EventTime: 120.5,
            KillerName: 'Faker',
            VictimName: 'Chovy',
            wallTs: 1_700_000_000_100
          }
        ]
      })
    },
    recorder: {
      dump: () => ({
        entries: [
          {
            ts: 10,
            wallTs: 1_700_000_000_010,
            kind: 'event',
            uri: '/lol-gameflow/v1/session',
            data: 'InProgress'
          }
        ]
      })
    },
    consoleTailer: {
      tail: () => ({
        entries: [
          {
            ts: 20,
            wallTs: 1_700_000_000_020,
            kind: 'console',
            level: 'info',
            text: 'UI ready'
          }
        ]
      })
    },
    networkTailer: {
      tail: () => ({
        entries: [
          {
            ts: 30,
            wallTs: 1_700_000_000_030,
            kind: 'request',
            method: 'GET',
            url: '/lol-gameflow/v1/session',
            status: 200,
            durationMs: 12
          }
        ]
      })
    },
    logWatcher: {
      statusSnapshot: () => ({ running: true, target: 'client', entries: 1 }),
      poll: () => ({
        entries: [
          {
            target: 'client',
            level: 'INFO',
            message: 'Renderer started',
            wallTime: 1_700_000_000_040
          }
        ]
      })
    },
    logReader: {
      tail: async () => {
        logReaderCalled = true;
        return {
          target: 'client',
          filePath: 'C:\\Logs\\LeagueClient.log',
          totalSize: 1024,
          returned: 1,
          entries: [
            {
              target: 'client',
              level: 'WARN',
              message: 'Fallback disk line',
              wallTime: 1_700_000_000_000
            }
          ]
        };
      }
    },
    get logReaderCalled() {
      return logReaderCalled;
    },
    secrets: () => [],
    ...overrides
  };
}

test('createForensicsBundle with full mock context returns Markdown with all expected sections', async () => {
  const ctx = createMockContext();
  const md = await createForensicsBundle(ctx, { format: 'markdown' });

  assert.equal(typeof md, 'string');
  assert.ok(md.includes('# LCU Diagnostics Bundle'));
  assert.ok(md.includes('## System Status'));
  assert.ok(md.includes('## Telemetry Summary'));
  assert.ok(md.includes('## Timeline Narrative'));

  // System Status details
  assert.ok(md.includes('29669'));
  assert.ok(md.includes('1234'));
  assert.ok(md.includes('WAMP'));
  assert.ok(md.includes('Console'));
  assert.ok(md.includes('Network'));
  assert.ok(md.includes('Logs'));

  // Timeline narrative entries from all 5 streams
  assert.ok(md.includes('[WAMP:event]'));
  assert.ok(md.includes('[CDP:console]'));
  assert.ok(md.includes('[NETWORK:request]'));
  assert.ok(md.includes('[LOGS:log]'));
  assert.ok(md.includes('[GAME:ChampionKill]'));

  // Fallback disk tail should NOT be present since logWatcher provided entries
  assert.ok(!md.includes('## Disk Logs Tail'));
  assert.equal(ctx.logReaderCalled, false);
});

test('createForensicsBundle returns structured JSON format', async () => {
  const ctx = createMockContext();
  const bundle = await createForensicsBundle(ctx, { format: 'json' });

  assert.equal(typeof bundle, 'object');
  assert.ok(bundle !== null);
  assert.equal(typeof bundle.generatedAt, 'string');

  // Status structure
  assert.deepEqual(bundle.status.lcu, { connected: true, port: 29669, pid: 1234 });
  assert.equal(bundle.status.cdp.running, true);
  assert.equal(bundle.status.cdp.attached, true);
  assert.equal(bundle.status.game, true);
  assert.equal(bundle.status.watchers.wamp, true);
  assert.equal(bundle.status.watchers.console, true);
  assert.equal(bundle.status.watchers.network, true);
  assert.equal(bundle.status.watchers.logs.running, true);

  // Summary structure
  assert.equal(bundle.summary.total, 5);
  assert.deepEqual(bundle.summary.sources, {
    wamp: 1,
    cdp: 1,
    network: 1,
    logs: 1,
    game: 1
  });

  // Timeline events array
  assert.ok(Array.isArray(bundle.timeline));
  assert.equal(bundle.timeline.length, 5);
  assert.equal(bundle.timeline[0].source, 'wamp');
  assert.equal(bundle.timeline[1].source, 'cdp');
  assert.equal(bundle.timeline[2].source, 'network');
  assert.equal(bundle.timeline[3].source, 'logs');
  assert.equal(bundle.timeline[4].source, 'game');

  // No fallback disk tail when logs were active
  assert.equal(bundle.diskLogTail, null);
});

test('fallback to logReader when logWatcher is inactive and includeLogTail is true', async () => {
  const ctx = createMockContext({
    logWatcher: {
      statusSnapshot: () => ({ running: false }),
      poll: () => ({ entries: [] })
    }
  });

  // Markdown format
  const md = await createForensicsBundle(ctx, { format: 'markdown', includeLogTail: true });
  assert.ok(md.includes('## Disk Logs Tail'));
  assert.ok(md.includes('Fallback disk line'));

  // JSON format
  const bundle = await createForensicsBundle(ctx, { format: 'json', includeLogTail: true });
  assert.ok(bundle.diskLogTail !== null);
  const diskEntries = Array.isArray(bundle.diskLogTail)
    ? bundle.diskLogTail
    : bundle.diskLogTail.entries;
  assert.equal(diskEntries.length, 1);
  assert.equal(diskEntries[0].message, 'Fallback disk line');
});

test('does not fallback to logReader when includeLogTail is false', async () => {
  let logReaderCalled = false;
  const ctx = createMockContext({
    logWatcher: {
      statusSnapshot: () => ({ running: false }),
      poll: () => ({ entries: [] })
    },
    logReader: {
      tail: async () => {
        logReaderCalled = true;
        return { entries: [{ message: 'Should not appear' }] };
      }
    }
  });

  const md = await createForensicsBundle(ctx, { format: 'markdown', includeLogTail: false });
  assert.ok(!md.includes('## Disk Logs Tail'));
  assert.equal(logReaderCalled, false);

  const bundle = await createForensicsBundle(ctx, { format: 'json', includeLogTail: false });
  assert.equal(bundle.diskLogTail, null);
  assert.equal(logReaderCalled, false);
});

test('does not fallback to logReader when logWatcher has entries', async () => {
  let logReaderCalled = false;
  const ctx = createMockContext({
    logWatcher: {
      statusSnapshot: () => ({ running: true }),
      poll: () => ({ entries: [{ target: 'client', message: 'Active log entry' }] })
    },
    logReader: {
      tail: async () => {
        logReaderCalled = true;
        return { entries: [] };
      }
    }
  });

  const md = await createForensicsBundle(ctx, { format: 'markdown', includeLogTail: true });
  assert.ok(!md.includes('## Disk Logs Tail'));
  assert.equal(logReaderCalled, false);

  const bundle = await createForensicsBundle(ctx, { format: 'json', includeLogTail: true });
  assert.equal(bundle.diskLogTail, null);
  assert.equal(logReaderCalled, false);
});

test('tokens and passwords in secrets are redacted across both markdown and json formats', async () => {
  const secretToken = 'BEARER_TOKEN_SECRET_98765';
  const secretPassword = 'P@ssw0rd_SUPER_SECRET';

  const ctx = createMockContext({
    secrets: () => [secretToken, secretPassword],
    recorder: {
      dump: () => ({
        entries: [
          {
            ts: 1,
            wallTs: 1000,
            kind: 'event',
            uri: `/lol-login/v1/token?token=${secretToken}`,
            data: { auth: secretPassword }
          }
        ]
      })
    },
    consoleTailer: {
      tail: () => ({
        entries: [
          {
            ts: 2,
            wallTs: 1001,
            kind: 'console',
            level: 'error',
            text: `Failed to auth with ${secretPassword}`
          }
        ]
      })
    },
    networkTailer: {
      tail: () => ({
        entries: [
          {
            ts: 3,
            wallTs: 1002,
            kind: 'request',
            method: 'POST',
            url: `https://127.0.0.1/auth?token=${secretToken}`,
            status: 401,
            errorText: `Unauthorized: ${secretPassword}`
          }
        ]
      })
    },
    logWatcher: {
      statusSnapshot: () => ({ running: false }),
      poll: () => ({ entries: [] })
    },
    logReader: {
      tail: async () => ({
        target: 'client',
        filePath: 'C:\\Logs\\LeagueClient.log',
        entries: [
          {
            target: 'client',
            level: 'INFO',
            message: `Logging with session ${secretToken}`
          }
        ]
      })
    }
  });

  // Markdown format redaction
  const md = await createForensicsBundle(ctx, { format: 'markdown', includeLogTail: true });
  assert.ok(!md.includes(secretToken), 'Secret token must not appear in Markdown');
  assert.ok(!md.includes(secretPassword), 'Secret password must not appear in Markdown');
  assert.ok(md.includes('***'), 'Markdown must contain *** redaction markers');

  // JSON format redaction
  const bundle = await createForensicsBundle(ctx, { format: 'json', includeLogTail: true });
  const jsonStr = JSON.stringify(bundle);
  assert.ok(!jsonStr.includes(secretToken), 'Secret token must not appear in JSON');
  assert.ok(!jsonStr.includes(secretPassword), 'Secret password must not appear in JSON');
  assert.ok(jsonStr.includes('***'), 'JSON must contain *** redaction markers');
});

test('handles empty or missing context gracefully without crashing', async () => {
  const md = await createForensicsBundle({}, { format: 'markdown' });
  assert.ok(typeof md === 'string');
  assert.ok(md.includes('# LCU Diagnostics Bundle'));
  assert.ok(md.includes('## System Status'));
  assert.ok(md.includes('Disconnected'));

  const bundle = await createForensicsBundle({}, { format: 'json' });
  assert.equal(typeof bundle, 'object');
  assert.deepEqual(bundle.status.lcu, { connected: false, port: null, pid: null });
  assert.deepEqual(bundle.status.cdp, { running: false, attached: false });
  assert.equal(bundle.status.game, false);
  assert.deepEqual(bundle.status.watchers, {
    wamp: false,
    console: false,
    network: false,
    logs: { running: false }
  });
  assert.equal(bundle.summary.total, 0);
  assert.deepEqual(bundle.timeline, []);
  assert.equal(bundle.diskLogTail, null);
});

test('handles throwing context methods without crashing', async () => {
  const throwingCtx = {
    lcu: {
      isConnected: () => {
        throw new Error('LCU crash');
      },
      port: 1111,
      pid: 2222
    },
    cdp: {
      statusSnapshot: () => {
        throw new Error('CDP crash');
      }
    },
    gameClient: {
      isGameRunning: async () => {
        throw new Error('Game client crash');
      },
      getEvents: async () => {
        throw new Error('Game getEvents crash');
      }
    },
    recorder: {
      dump: () => {
        throw new Error('Recorder dump crash');
      }
    },
    consoleTailer: {
      tail: () => {
        throw new Error('Console tail crash');
      }
    },
    networkTailer: {
      tail: () => {
        throw new Error('Network tail crash');
      }
    },
    logWatcher: {
      statusSnapshot: () => {
        throw new Error('LogWatcher status crash');
      },
      poll: () => {
        throw new Error('LogWatcher poll crash');
      }
    },
    logReader: {
      tail: async () => {
        throw new Error('LogReader tail crash');
      }
    },
    secrets: () => {
      throw new Error('Secrets crash');
    }
  };

  const md = await createForensicsBundle(throwingCtx, { format: 'markdown' });
  assert.ok(typeof md === 'string');
  assert.ok(md.includes('# LCU Diagnostics Bundle'));

  const bundle = await createForensicsBundle(throwingCtx, { format: 'json' });
  assert.equal(bundle.status.lcu.connected, false);
  assert.equal(bundle.status.lcu.port, 1111);
  assert.equal(bundle.status.lcu.pid, 2222);
  assert.deepEqual(bundle.status.cdp, { running: false, attached: false });
  assert.equal(bundle.status.game, false);
  assert.equal(bundle.summary.total, 0);
  assert.deepEqual(bundle.timeline, []);
  assert.equal(bundle.diskLogTail, null);
});

test('filters telemetry by sources parameter', async () => {
  const ctx = createMockContext();
  const bundle = await createForensicsBundle(ctx, {
    format: 'json',
    sources: ['wamp', 'network']
  });

  assert.equal(bundle.summary.total, 2);
  assert.equal(bundle.timeline.length, 2);
  assert.equal(bundle.summary.sources.wamp, 1);
  assert.equal(bundle.summary.sources.network, 1);
  assert.equal(bundle.summary.sources.cdp, 0);
  assert.equal(bundle.summary.sources.logs, 0);
  assert.equal(bundle.summary.sources.game, 0);
  assert.ok(bundle.timeline.every((e) => e.source === 'wamp' || e.source === 'network'));
});

test('limits total events in timeline via limit parameter', async () => {
  const ctx = createMockContext();
  const bundle = await createForensicsBundle(ctx, {
    format: 'json',
    limit: 2
  });

  assert.equal(bundle.timeline.length, 2);
});

test('does not fetch game events when game is not running', async () => {
  let getEventsCalled = false;
  const ctx = createMockContext({
    gameClient: {
      isGameRunning: async () => false,
      getEvents: async () => {
        getEventsCalled = true;
        return { Events: [] };
      }
    }
  });

  const bundle = await createForensicsBundle(ctx, { format: 'json' });
  assert.equal(bundle.status.game, false);
  assert.equal(bundle.summary.sources.game, 0);
  assert.equal(getEventsCalled, false);
});
