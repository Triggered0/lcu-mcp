import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CdpUnavailableError,
  DEFAULT_PENGU_CONFIG_PATH,
  clearPortCache,
  findPageTarget,
  findProcessCdpPort,
  listTargets,
  penguHint,
  probeVersion,
  readPenguConfig,
  redactTarget,
  resolveCdpPort
} from '../src/cdp/discover.js';

const PASSWORD = 'S3cr3t-Pa55';

function stubCdp(routes) {
  const server = createServer((req, res) => {
    const body = routes[req.url];
    if (body === undefined) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => server.close() }));
  });
}

const PAGE_TARGET = {
  id: 'ABC123',
  type: 'page',
  title: 'League Client',
  url: `https://riot:${PASSWORD}@127.0.0.1:29669/index.html`,
  webSocketDebuggerUrl: 'ws://127.0.0.1:8888/devtools/page/ABC123'
};

test('redactTarget strips the password from the target url', () => {
  const out = redactTarget(PAGE_TARGET);
  assert.ok(!JSON.stringify(out).includes(PASSWORD));
  assert.equal(out.webSocketDebuggerUrl, PAGE_TARGET.webSocketDebuggerUrl);
  assert.equal(out.id, 'ABC123');
});

test('probeVersion returns the CEF version payload', async () => {
  const server = await stubCdp({ '/json/version': { Browser: 'Chrome/108.0.0.0', 'Protocol-Version': '1.3' } });
  try {
    const version = await probeVersion(server.port);
    assert.equal(version['Protocol-Version'], '1.3');
  } finally {
    server.close();
  }
});

test('findPageTarget selects the page target and redacts it', async () => {
  const server = await stubCdp({
    '/json/version': { Browser: 'Chrome/108.0.0.0' },
    '/json/list': [{ id: 'OTHER', type: 'other', url: 'about:blank' }, PAGE_TARGET]
  });
  try {
    const target = await findPageTarget(server.port);
    assert.equal(target.id, 'ABC123');
    assert.ok(!target.url.includes(PASSWORD));
  } finally {
    server.close();
  }
});

test('listTargets returns all targets with redacted URLs', async () => {
  const server = await stubCdp({
    '/json/list': [
      { id: 'OTHER', type: 'other', title: 'devtools', url: `https://riot:${PASSWORD}@127.0.0.1:29669/devtools.html` },
      PAGE_TARGET
    ]
  });
  try {
    const targets = await listTargets(server.port);
    assert.equal(targets.length, 2);
    assert.equal(targets[0].id, 'OTHER');
    assert.ok(!targets[0].url.includes(PASSWORD));
    assert.equal(targets[1].id, 'ABC123');
    assert.ok(!targets[1].url.includes(PASSWORD));
  } finally {
    server.close();
  }
});

test('listTargets returns empty array when no targets exist', async () => {
  const server = await stubCdp({
    '/json/list': []
  });
  try {
    const targets = await listTargets(server.port);
    assert.deepEqual(targets, []);
  } finally {
    server.close();
  }
});

test('listTargets throws CdpUnavailableError on closed port', async () => {
  const server = await stubCdp({});
  const port = server.port;
  server.close();
  await new Promise((r) => setTimeout(r, 20));

  await assert.rejects(listTargets(port), (err) => {
    assert.ok(err instanceof CdpUnavailableError);
    assert.match(err.message, /Pengu Loader not active or RemoteDebuggingPort unset/);
    return true;
  });
});

test('a closed port yields the Pengu hint, not ECONNREFUSED', async () => {
  const server = await stubCdp({});
  const port = server.port;
  server.close();
  await new Promise((r) => setTimeout(r, 20));

  await assert.rejects(findPageTarget(port), (err) => {
    assert.ok(err instanceof CdpUnavailableError);
    assert.match(err.message, /Pengu Loader not active or RemoteDebuggingPort unset/);
    assert.match(err.message, /kill-and-restart-ux/);
    assert.ok(err.message.startsWith('CDP unavailable on port'), 'the fix leads, the socket code is only a detail');
    return true;
  });
});

test('no page target yields a distinct explanation', async () => {
  const server = await stubCdp({ '/json/version': { Browser: 'x' }, '/json/list': [{ id: 'X', type: 'other' }] });
  try {
    await assert.rejects(findPageTarget(server.port), /no "page" target/);
  } finally {
    server.close();
  }
});

// Regression: the hint must carry the real Windows path, not a backslash-eaten one.
test('penguHint names the actual Pengu config path', () => {
  assert.match(penguHint(8888), /C:\\Program Files\\Pengu Loader\\config/);
  assert.match(penguHint(8888), /RemoteDebuggingPort=8888/);
});

test('DEFAULT_PENGU_CONFIG_PATH points to standard Windows path', () => {
  assert.equal(DEFAULT_PENGU_CONFIG_PATH, 'C:\\Program Files\\Pengu Loader\\config');
});

test('readPenguConfig extracts RemoteDebuggingPort from config text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pengu-test-'));
  const filePath = join(dir, 'config');
  try {
    await writeFile(filePath, 'SomeKey=abc\nRemoteDebuggingPort=9001\nOtherKey=123\n');
    const port = await readPenguConfig(filePath);
    assert.equal(port, 9001);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readPenguConfig returns null for missing file or missing key', async () => {
  const missing = await readPenguConfig('C:\\non_existent_path_test\\config');
  assert.equal(missing, null);

  const dir = await mkdtemp(join(tmpdir(), 'pengu-test-'));
  const filePath = join(dir, 'config');
  try {
    await writeFile(filePath, 'SomeKey=abc\n');
    assert.equal(await readPenguConfig(filePath), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readPenguConfig returns null for out-of-range or invalid ports', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pengu-test-'));
  const filePath = join(dir, 'config');
  try {
    await writeFile(filePath, 'RemoteDebuggingPort=0\n');
    assert.equal(await readPenguConfig(filePath), null);

    await writeFile(filePath, 'RemoteDebuggingPort=65536\n');
    assert.equal(await readPenguConfig(filePath), null);

    await writeFile(filePath, 'RemoteDebuggingPort=not-a-number\n');
    assert.equal(await readPenguConfig(filePath), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('findProcessCdpPort parses --remote-debugging-port from command line', async () => {
  const fakeExec = async () => 'LeagueClientUxRender.exe --type=renderer --remote-debugging-port=9222 --lang=en';
  const port = await findProcessCdpPort({ execCmd: fakeExec, platform: 'win32' });
  assert.equal(port, 9222);
});

test('findProcessCdpPort returns null when flag is missing or not win32', async () => {
  const fakeExec = async () => 'LeagueClientUxRender.exe --type=gpu-process';
  assert.equal(await findProcessCdpPort({ execCmd: fakeExec, platform: 'win32' }), null);
  assert.equal(await findProcessCdpPort({ execCmd: fakeExec, platform: 'linux' }), null);
});

test('findProcessCdpPort returns null when execCmd throws or returns non-string', async () => {
  const throwingExec = async () => {
    throw new Error('Command failed');
  };
  assert.equal(await findProcessCdpPort({ execCmd: throwingExec, platform: 'win32' }), null);

  const nonStringExec = async () => null;
  assert.equal(await findProcessCdpPort({ execCmd: nonStringExec, platform: 'win32' }), null);
});

test('resolveCdpPort adheres to priority order', async () => {
  clearPortCache();
  // 1. Explicit config wins over env var and file
  let res = await resolveCdpPort({
    config: { cdpPort: 7777 },
    env: { LCU_CDP_PORT: '7788' },
    readConfigFile: async () => 8899,
    scanProcesses: async () => 9988
  });
  assert.deepEqual(res, { port: 7777, source: 'explicit' });

  clearPortCache();
  // 'auto' or null in config falls through to env
  res = await resolveCdpPort({
    config: { cdpPort: 'auto' },
    env: { LCU_CDP_PORT: '7788' }
  });
  assert.deepEqual(res, { port: 7788, source: 'env' });

  clearPortCache();
  res = await resolveCdpPort({
    config: { cdpPort: null },
    env: { LCU_CDP_PORT: '7788' }
  });
  assert.deepEqual(res, { port: 7788, source: 'env' });

  clearPortCache();
  // Out of range port in config falls through
  res = await resolveCdpPort({
    config: { cdpPort: 70000 },
    env: { LCU_CDP_PORT: '7788' }
  });
  assert.deepEqual(res, { port: 7788, source: 'env' });

  clearPortCache();
  // 2. Env var wins over file
  res = await resolveCdpPort({
    config: {},
    env: { LCU_CDP_PORT: '7788' },
    readConfigFile: async () => 8899,
    scanProcesses: async () => 9988
  });
  assert.deepEqual(res, { port: 7788, source: 'env' });

  clearPortCache();
  // 3. File wins over process
  res = await resolveCdpPort({
    config: {},
    env: {},
    readConfigFile: async () => 8899,
    scanProcesses: async () => 9988
  });
  assert.deepEqual(res, { port: 8899, source: 'pengu-config' });

  clearPortCache();
  // 4. Process wins over fallback
  res = await resolveCdpPort({
    config: {},
    env: {},
    readConfigFile: async () => null,
    scanProcesses: async () => 9988
  });
  assert.deepEqual(res, { port: 9988, source: 'process' });

  clearPortCache();
  // 5. Fallback
  res = await resolveCdpPort({
    config: {},
    env: {},
    readConfigFile: async () => null,
    scanProcesses: async () => null
  });
  assert.deepEqual(res, { port: 8888, source: 'fallback' });
});

test('resolveCdpPort caches results and supports forceRefresh and clearPortCache', async () => {
  clearPortCache();
  let calls = 0;
  const mockReadFile = async () => {
    calls++;
    return 9100;
  };

  const first = await resolveCdpPort({ config: {}, env: {}, readConfigFile: mockReadFile });
  assert.deepEqual(first, { port: 9100, source: 'pengu-config' });
  assert.equal(calls, 1);

  // Cached call doesn't call mockReadFile again
  const second = await resolveCdpPort({ config: {}, env: {}, readConfigFile: mockReadFile });
  assert.deepEqual(second, { port: 9100, source: 'pengu-config' });
  assert.equal(calls, 1);

  // forceRefresh: true bypasses cache
  const refreshed = await resolveCdpPort({ config: {}, env: {}, forceRefresh: true, readConfigFile: mockReadFile });
  assert.deepEqual(refreshed, { port: 9100, source: 'pengu-config' });
  assert.equal(calls, 2);

  // clearPortCache clears cache
  clearPortCache();
  const afterClear = await resolveCdpPort({ config: {}, env: {}, readConfigFile: mockReadFile });
  assert.deepEqual(afterClear, { port: 9100, source: 'pengu-config' });
  assert.equal(calls, 3);
});

