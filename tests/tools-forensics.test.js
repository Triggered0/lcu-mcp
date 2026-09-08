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
    wampCount: 1,
    cdpCount: 1,
    errorCount: 1,
    timeSpanMs: 5,
    firstTs: 1000,
    lastTs: 1005
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

