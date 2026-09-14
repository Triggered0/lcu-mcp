import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerForensicsTools } from '../src/tools/forensics.js';

function register(ctxOverrides = {}) {
  const handlers = new Map();
  const server = { registerTool: (name, _meta, handler) => handlers.set(name, handler) };
  const ctx = {
    recorder: {
      dump: () => ({ entries: [] })
    },
    consoleTailer: {
      tail: () => ({ entries: [] })
    },
    secrets: () => [],
    ...ctxOverrides
  };
  registerForensicsTools(server, ctx);
  return { handlers, ctx };
}

test('default call returns narrative text', async () => {
  const { handlers } = register({
    recorder: {
      dump: () => ({
        entries: [
          { ts: 1000, wallTs: 1700000001000, kind: 'event', uri: '/lol-gameflow/v1/gameflow-phase', data: 'ChampSelect' }
        ]
      })
    },
    consoleTailer: {
      tail: () => ({
        entries: [
          { ts: 1005, wallTs: 1700000001005, kind: 'console', level: 'error', text: 'Boom' }
        ]
      })
    }
  });

  const tool = handlers.get('lol_forensics_correlate');
  assert.ok(tool, 'lol_forensics_correlate tool must be registered');

  const result = await tool({});
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].type, 'text');
  assert.match(result.content[0].text, /=== CORRELATED FORENSICS TIMELINE \(2 events\) ===/);
  assert.match(result.content[0].text, /\[WAMP:event\] \/lol-gameflow\/v1\/gameflow-phase -> "ChampSelect"/);
  assert.match(result.content[0].text, /\[CDP:console\] \[error\] Boom/);
});

test('format: events returns interleaved JSON array', async () => {
  const { handlers } = register({
    recorder: {
      dump: () => ({
        entries: [
          { ts: 1000, wallTs: 1700000001000, kind: 'event', uri: '/lol-gameflow/v1/gameflow-phase', data: 'ChampSelect' }
        ]
      })
    },
    consoleTailer: {
      tail: () => ({
        entries: [
          { ts: 1005, wallTs: 1700000001005, kind: 'console', level: 'error', text: 'Boom' }
        ]
      })
    }
  });

  const tool = handlers.get('lol_forensics_correlate');
  const result = await tool({ format: 'events' });
  assert.equal(result.isError, undefined);
  const events = JSON.parse(result.content[0].text);
  assert.ok(Array.isArray(events));
  assert.equal(events.length, 2);
  assert.equal(events[0].source, 'wamp');
  assert.equal(events[0].ts, 1000);
  assert.equal(events[1].source, 'cdp');
  assert.equal(events[1].ts, 1005);
});

test('format: summary returns summary stats object', async () => {
  const { handlers } = register({
    recorder: {
      dump: () => ({
        entries: [
          { ts: 1000, wallTs: 1700000001000, kind: 'event', uri: '/lol-gameflow/v1/gameflow-phase', data: 'ChampSelect' }
        ]
      })
    },
    consoleTailer: {
      tail: () => ({
        entries: [
          { ts: 1005, wallTs: 1700000001005, kind: 'console', level: 'error', text: 'Boom' }
        ]
      })
    }
  });

  const tool = handlers.get('lol_forensics_correlate');
  const result = await tool({ format: 'summary' });
  assert.equal(result.isError, undefined);
  const summary = JSON.parse(result.content[0].text);
  assert.deepEqual(summary, {
    total: 2,
    sources: {
      wamp: 1,
      cdp: 1,
      network: 0,
      logs: 0,
      game: 0
    },
    errorCount: 1,
    timeSpanMs: 5,
    firstTs: 1700000001000,
    lastTs: 1700000001005
  });
});

test('forwards filters (since, until, uriPrefix, levels, limit)', async () => {
  const dumpCalls = [];
  const tailCalls = [];
  const { handlers } = register({
    recorder: {
      dump: (opts) => {
        dumpCalls.push(opts);
        return { entries: [] };
      }
    },
    consoleTailer: {
      tail: (opts) => {
        tailCalls.push(opts);
        return { entries: [] };
      }
    }
  });

  const tool = handlers.get('lol_forensics_correlate');
  await tool({
    since: 1000,
    until: 2000,
    uriPrefix: '/lol-gameflow/',
    levels: ['error', 'warning'],
    limit: 50
  });

  assert.equal(dumpCalls.length, 1);
  assert.deepEqual(dumpCalls[0], {
    since: 1000,
    until: 2000,
    uri: '/lol-gameflow/',
    limit: 50
  });

  assert.equal(tailCalls.length, 1);
  assert.deepEqual(tailCalls[0], {
    since: 1000,
    until: 2000,
    levels: ['error', 'warning'],
    limit: 50
  });
});

test('tolerates stopped or throwing recorder and console tailer without error', async () => {
  const { handlers } = register({
    recorder: {
      dump: () => {
        throw new Error('A recording is not running');
      }
    },
    consoleTailer: {
      tail: () => {
        throw new Error('The console tailer is not running, so there is nothing to tail.');
      }
    }
  });

  const tool = handlers.get('lol_forensics_correlate');
  const result = await tool({});
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /=== CORRELATED FORENSICS TIMELINE \(0 events\) ===/);

  const summaryResult = await tool({ format: 'summary' });
  assert.equal(summaryResult.isError, undefined);
  const summary = JSON.parse(summaryResult.content[0].text);
  assert.equal(summary.total, 0);
});

test('tolerates missing or null recorder and console tailer on ctx', async () => {
  const { handlers } = register({
    recorder: null,
    consoleTailer: null
  });

  const tool = handlers.get('lol_forensics_correlate');
  const result = await tool({});
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /=== CORRELATED FORENSICS TIMELINE \(0 events\) ===/);
});

test('createServer integrates lol_forensics_correlate over MCP transport', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createServer } = await import('../src/index.js');
  const { fakeContext } = await import('./helpers/context.js');

  const ctx = fakeContext();
  const server = createServer(ctx);
  const client = new Client({ name: 'test', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);

  const result = await client.callTool({
    name: 'lol_forensics_correlate',
    arguments: { format: 'summary' }
  });
  assert.equal(result.isError, undefined);
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.total, 0);

  await client.close();
});

test('filters cdp entries by levels in narrative output', async () => {
  const { handlers } = register({
    recorder: {
      dump: () => ({ entries: [] })
    },
    consoleTailer: {
      tail: () => ({
        entries: [
          { ts: 1000, wallTs: 1700000001000, kind: 'console', level: 'info', text: 'ignore me' },
          { ts: 1005, wallTs: 1700000001005, kind: 'console', level: 'error', text: 'catch me' }
        ]
      })
    }
  });

  const tool = handlers.get('lol_forensics_correlate');
  const result = await tool({ levels: ['error'] });
  assert.equal(result.isError, undefined);
  assert.ok(!result.content[0].text.includes('ignore me'));
  assert.ok(result.content[0].text.includes('catch me'));
});

test('ingests network and log entries when networkTailer and logWatcher are present', async () => {
  const networkCalls = [];
  const logCalls = [];
  const { handlers } = register({
    recorder: {
      dump: () => ({
        entries: [
          { ts: 1000, wallTs: 1700000001000, kind: 'event', uri: '/lol-gameflow/v1/session', data: 'InProgress' }
        ]
      })
    },
    consoleTailer: {
      tail: () => ({
        entries: [
          { ts: 1005, wallTs: 1700000001005, kind: 'console', level: 'info', text: 'Ready' }
        ]
      })
    },
    networkTailer: {
      tail: (opts) => {
        networkCalls.push(opts);
        return {
          entries: [
            {
              ts: 1010,
              wallTs: 1700000001010,
              kind: 'request',
              method: 'GET',
              url: '/lol-gameflow/v1/session',
              status: 200,
              durationMs: 15
            }
          ]
        };
      }
    },
    logWatcher: {
      poll: (opts) => {
        logCalls.push(opts);
        return {
          entries: [
            {
              ts: 1015,
              wallTs: 1700000001015,
              kind: 'log',
              target: 'client',
              level: 'INFO',
              message: 'Session updated'
            }
          ]
        };
      }
    }
  });

  const tool = handlers.get('lol_forensics_correlate');

  // Test events format
  const resultEvents = await tool({
    networkFailedOnly: true,
    logLevel: 'INFO',
    format: 'events'
  });
  assert.equal(resultEvents.isError, undefined);
  const events = JSON.parse(resultEvents.content[0].text);
  assert.equal(events.length, 4);
  assert.equal(events[0].source, 'wamp');
  assert.equal(events[1].source, 'cdp');
  assert.equal(events[2].source, 'network');
  assert.equal(events[3].source, 'logs');

  assert.equal(networkCalls.length, 1);
  assert.deepEqual(networkCalls[0], {
    since: undefined,
    until: undefined,
    failedOnly: true,
    limit: 100
  });

  assert.equal(logCalls.length, 1);
  assert.deepEqual(logCalls[0], {
    limit: 100,
    level: 'INFO'
  });

  // Test narrative format
  const resultNarrative = await tool({ format: 'narrative' });
  assert.equal(resultNarrative.isError, undefined);
  const narrativeText = resultNarrative.content[0].text;
  assert.ok(narrativeText.includes('[WAMP:event]'));
  assert.ok(narrativeText.includes('[CDP:console]'));
  assert.ok(narrativeText.includes('[NETWORK:request]'));
  assert.ok(narrativeText.includes('[LOGS:log]'));
});

test('tolerates stopped or throwing networkTailer and logWatcher without error', async () => {
  const { handlers } = register({
    networkTailer: {
      tail: () => {
        throw new Error('Network tailer stopped');
      }
    },
    logWatcher: {
      poll: () => {
        throw new Error('Log watcher stopped');
      }
    }
  });

  const tool = handlers.get('lol_forensics_correlate');
  const result = await tool({});
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /=== CORRELATED FORENSICS TIMELINE \(0 events\) ===/);
});

test('lol_forensics_bundle generates Markdown report with all sections', async () => {
  const { handlers } = register({
    recorder: {
      dump: () => ({
        entries: [
          { ts: 10, wallTs: 1700000000010, kind: 'event', uri: '/lol-gameflow/v1/session', data: 'InProgress' }
        ]
      })
    },
    consoleTailer: {
      tail: () => ({
        entries: [
          { ts: 20, wallTs: 1700000000020, kind: 'console', level: 'info', text: 'UI ready' }
        ]
      })
    }
  });

  const bundleTool = handlers.get('lol_forensics_bundle');
  assert.ok(bundleTool, 'lol_forensics_bundle must be registered');

  const result = await bundleTool({ format: 'markdown' });
  assert.equal(result.isError, undefined);
  const text = result.content[0].text;
  assert.ok(text.includes('# LCU Diagnostics Bundle'));
  assert.ok(text.includes('## System Status'));
  assert.ok(text.includes('## Telemetry Summary'));
  assert.ok(text.includes('## Timeline Narrative'));
  assert.ok(text.includes('[WAMP:event]'));
  assert.ok(text.includes('[CDP:console]'));
});

test('lol_forensics_bundle generates structured JSON report', async () => {
  const { handlers } = register({
    recorder: {
      dump: () => ({
        entries: [
          { ts: 10, wallTs: 1700000000010, kind: 'event', uri: '/lol-gameflow/v1/session', data: 'InProgress' }
        ]
      })
    },
    consoleTailer: {
      tail: () => ({
        entries: [
          { ts: 20, wallTs: 1700000000020, kind: 'console', level: 'info', text: 'UI ready' }
        ]
      })
    }
  });

  const bundleTool = handlers.get('lol_forensics_bundle');
  const result = await bundleTool({ format: 'json' });
  assert.equal(result.isError, undefined);
  const data = JSON.parse(result.content[0].text);
  assert.equal(typeof data.generatedAt, 'string');
  assert.ok(data.status);
  assert.ok(data.summary);
  assert.ok(Array.isArray(data.timeline));
  assert.equal(data.summary.total, 2);
  assert.equal(data.timeline.length, 2);
});

test('createServer integrates lol_forensics_bundle over MCP transport', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createServer } = await import('../src/index.js');
  const { fakeContext } = await import('./helpers/context.js');

  const ctx = fakeContext();
  const server = createServer(ctx);
  const client = new Client({ name: 'test', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);

  const result = await client.callTool({
    name: 'lol_forensics_bundle',
    arguments: { format: 'json' }
  });
  assert.equal(result.isError, undefined);
  const data = JSON.parse(result.content[0].text);
  assert.equal(typeof data.generatedAt, 'string');
  assert.ok(data.status);
  assert.equal(data.summary.total, 0);

  await client.close();
});



