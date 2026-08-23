import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { CdpUnavailableError, findPageTarget, penguHint, probeVersion, redactTarget } from '../src/cdp/discover.js';

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
