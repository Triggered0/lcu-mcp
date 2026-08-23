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
      evaluate: async () => null,
      domQuery: async () => null
    },
    tap: {
      statusSnapshot: () => ({ running: false, connected: false, filters: [], attempts: 0, buffered: buffer.length, lastError: null }),
      start: async () => {},
      stop: () => {}
    },
    secrets: () => ['S3cr3t-Pa55'],
    ...overrides
  };
}
