import { RingBuffer } from '../../src/lcu/buffer.js';

export function fakeContext(overrides = {}) {
  const buffer = new RingBuffer(10);
  return {
    config: { allowEval: true, cdpPort: 8888, eventBufferSize: 10, writeAllowlist: [], configPath: 'config/allowlist.json' },
    buffer,
    lcu: {
      statusSnapshot: () => ({ connected: true, port: 29669, lockfilePath: 'L', lastError: null }),
      request: async () => ({ status: 200, body: 'None' }),
      get: async () => ({ status: 200, body: 'None' })
    },
    cdp: {
      statusSnapshot: () => ({ attached: false, port: 8888, targetId: null, targetTitle: null, lastError: null }),
      evaluate: async () => ({ value: null, exceptionDetails: null }),
      domQuery: async () => null
    },
    tap: {
      statusSnapshot: () => ({ running: false, connected: false, filters: [], attempts: 0, buffered: buffer.length, lastError: null }),
      start: async () => {},
      stop: () => {}
    },
    recorder: {
      statusSnapshot: () => ({ running: false, startedAt: null, mode: 'firehose', uris: [], entries: 0, bytes: 0, droppedTotal: 0, lastError: null }),
      start: async () => ({ startedAt: 1, mode: 'firehose', uris: [] }),
      dump: () => ({ entries: [], stats: {}, dropped: 0, cursor: 0, remaining: 0, running: false, startedAt: null }),
      stop: () => ({ stopped: false, entries: 0 })
    },
    consoleTailer: {
      statusSnapshot: () => ({ running: false, startedAt: null, targetId: null, entries: 0, droppedTotal: 0, lastError: null }),
      start: async () => ({ startedAt: 1, targetId: null }),
      tail: () => ({ entries: [], cursor: 0, dropped: 0, remaining: 0, running: false, attached: false, targetId: null, startedAt: null }),
      stop: () => ({ stopped: false, entries: 0 })
    },
    secrets: () => ['S3cr3t-Pa55'],
    ...overrides
  };
}
