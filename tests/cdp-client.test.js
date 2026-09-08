import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CdpClient } from '../src/cdp/client.js';
import { CdpUnavailableError } from '../src/cdp/discover.js';

class FakeCdpSocket extends EventEmitter {
  sent = [];
  responder = () => null;
  send(text) {
    const message = JSON.parse(text);
    this.sent.push(message);
    const reply = this.responder(message);
    if (reply !== null) setImmediate(() => this.emit('message', JSON.stringify({ id: message.id, ...reply })));
  }
  close() { this.emit('close'); }
}

function harness({ discover } = {}) {
  const sockets = [];
  const client = new CdpClient({
    port: 8888,
    discover: discover ?? (async () => ({ id: 'ABC', title: 'League Client', webSocketDebuggerUrl: 'ws://127.0.0.1:8888/devtools/page/ABC' })),
    wsFactory: (url) => {
      const socket = new FakeCdpSocket();
      socket.url = url;
      sockets.push(socket);
      setImmediate(() => socket.emit('open'));
      return socket;
    }
  });
  return { client, sockets };
}

test('attach connects to the discovered target socket', async () => {
  const { client, sockets } = harness();
  await client.attach();
  assert.equal(sockets[0].url, 'ws://127.0.0.1:8888/devtools/page/ABC');
  assert.equal(client.statusSnapshot().attached, true);
  assert.equal(client.statusSnapshot().targetId, 'ABC');
  client.close();
});

test('attach is idempotent', async () => {
  const { client, sockets } = harness();
  await client.attach();
  await client.attach();
  assert.equal(sockets.length, 1);
  client.close();
});

test('send correlates responses by id', async () => {
  const { client, sockets } = harness();
  await client.attach();
  sockets[0].responder = (msg) => ({ result: { echo: msg.method } });
  assert.deepEqual(await client.send('Runtime.enable'), { echo: 'Runtime.enable' });
  client.close();
});

test('a CDP protocol error rejects with its message', async () => {
  const { client, sockets } = harness();
  await client.attach();
  sockets[0].responder = () => ({ error: { code: -32000, message: 'Cannot find context' } });
  await assert.rejects(client.send('Runtime.evaluate', {}), /Cannot find context/);
  client.close();
});

test('evaluate returns the by-value result', async () => {
  const { client, sockets } = harness();
  await client.attach();
  sockets[0].responder = (msg) => {
    assert.equal(msg.params.returnByValue, true);
    return { result: { result: { type: 'number', value: 42 } } };
  };
  assert.deepEqual(await client.evaluate('1 + 41'), { value: 42, exceptionDetails: null });
  client.close();
});

test('evaluate returns a page exception as structured data, not a throw', async () => {
  const { client, sockets } = harness();
  await client.attach();
  sockets[0].responder = () => ({
    result: {
      exceptionDetails: {
        text: 'Uncaught',
        lineNumber: 3,
        columnNumber: 11,
        exception: { description: 'ReferenceError: nope is not defined' },
        stackTrace: { callFrames: [{ functionName: 'probe', url: 'p.js', lineNumber: 3, columnNumber: 11 }] }
      }
    }
  });
  const result = await client.evaluate('nope');
  assert.equal(result.value, undefined);
  assert.equal(result.exceptionDetails.description, 'ReferenceError: nope is not defined');
  assert.equal(result.exceptionDetails.lineNumber, 3);
  assert.deepEqual(result.exceptionDetails.stackTrace, [
    { functionName: 'probe', url: 'p.js', lineNumber: 3, columnNumber: 11 }
  ]);
  client.close();
});

test('domQuery still throws on a page exception', async () => {
  const { client, sockets } = harness();
  await client.attach();
  sockets[0].responder = () => ({
    result: { exceptionDetails: { exception: { description: 'SyntaxError: bad selector' } } }
  });
  await assert.rejects(client.domQuery('.x'), /SyntaxError: bad selector/);
  client.close();
});

test('domQuery passes the selector as data, not code', async () => {
  const { client, sockets } = harness();
  await client.attach();
  sockets[0].responder = (msg) => {
    assert.ok(msg.params.expression.includes(JSON.stringify('.lol-uikit-flat-button')));
    return { result: { result: { type: 'object', value: [{ tag: 'BUTTON' }] } } };
  };
  const nodes = await client.domQuery('.lol-uikit-flat-button', { all: true, props: ['textContent'] });
  assert.deepEqual(nodes, [{ tag: 'BUTTON' }]);
  client.close();
});

test('attach failure is reported as CDP unavailable', async () => {
  const { client } = harness({
    discover: async () => {
      throw new CdpUnavailableError(8888, 'ECONNREFUSED');
    }
  });
  await assert.rejects(client.attach(), /Pengu Loader not active/);
  assert.equal(client.statusSnapshot().attached, false);
  assert.match(client.statusSnapshot().lastError, /Pengu Loader/);
});

test('on delivers CDP events to subscribers', async () => {
  const { client, sockets } = harness();
  await client.attach();
  const seen = [];
  client.on('Runtime.consoleAPICalled', (params) => seen.push(params));

  sockets[0].emit('message', JSON.stringify({
    method: 'Runtime.consoleAPICalled',
    params: { type: 'log', args: [{ type: 'string', value: 'hi' }] }
  }));

  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'log');
  client.close();
});

test('an event with no subscriber is ignored, not thrown', async () => {
  const { client, sockets } = harness();
  await client.attach();
  sockets[0].emit('message', JSON.stringify({ method: 'Runtime.somethingElse', params: {} }));
  assert.equal(client.statusSnapshot().attached, true);
  client.close();
});

test('on returns an unsubscribe that stops delivery', async () => {
  const { client, sockets } = harness();
  await client.attach();
  const seen = [];
  const off = client.on('Runtime.exceptionThrown', (p) => seen.push(p));
  sockets[0].emit('message', JSON.stringify({ method: 'Runtime.exceptionThrown', params: { a: 1 } }));
  off();
  sockets[0].emit('message', JSON.stringify({ method: 'Runtime.exceptionThrown', params: { a: 2 } }));
  assert.equal(seen.length, 1);
  client.close();
});

test('a throwing subscriber does not break the message loop', async () => {
  const { client, sockets } = harness();
  await client.attach();
  const seen = [];
  client.on('Runtime.consoleAPICalled', () => { throw new Error('subscriber blew up'); });
  client.on('Runtime.consoleAPICalled', (p) => seen.push(p));
  sockets[0].emit('message', JSON.stringify({ method: 'Runtime.consoleAPICalled', params: { type: 'log' } }));
  assert.equal(seen.length, 1, 'a later subscriber still receives the event');
  client.close();
});

test('onClose fires when the live socket closes', async () => {
  const { client, sockets } = harness();
  await client.attach();
  let closed = 0;
  client.onClose(() => { closed += 1; });
  sockets[0].close();
  assert.equal(closed, 1);
});

test('CdpClient calls portResolver if provided and updates port and statusSnapshot', async () => {
  let resolved = false;
  const client = new CdpClient({
    portResolver: async () => {
      resolved = true;
      return 9999;
    },
    discover: async (port) => {
      assert.equal(port, 9999);
      return { id: 'T1', webSocketDebuggerUrl: 'ws://127.0.0.1:9999/t1' };
    },
    wsFactory: () => {
      const emitter = new EventEmitter();
      emitter.send = () => {};
      emitter.close = () => {};
      process.nextTick(() => emitter.emit('open'));
      return emitter;
    }
  });
  assert.equal(client.statusSnapshot().port, undefined);
  await client.attach();
  assert.equal(resolved, true);
  assert.equal(client.port, 9999);
  assert.equal(client.statusSnapshot().port, 9999);
  client.close();
});

test('CdpClient accepts portResolver returning an object with port property', async () => {
  const client = new CdpClient({
    portResolver: async () => ({ port: 7777, source: 'pengu-config' }),
    discover: async (port) => {
      assert.equal(port, 7777);
      return { id: 'T2', webSocketDebuggerUrl: 'ws://127.0.0.1:7777/t2' };
    },
    wsFactory: () => {
      const emitter = new EventEmitter();
      emitter.send = () => {};
      emitter.close = () => {};
      process.nextTick(() => emitter.emit('open'));
      return emitter;
    }
  });
  await client.attach();
  assert.equal(client.port, 7777);
  assert.equal(client.statusSnapshot().port, 7777);
  client.close();
});

test('CdpClient.getPort resolves port when portResolver is present or returns static port', async () => {
  const staticClient = new CdpClient({ port: 8888 });
  assert.equal(await staticClient.getPort(), 8888);

  const dynamicClient = new CdpClient({
    portResolver: async () => 9222
  });
  assert.equal(await dynamicClient.getPort(), 9222);
  assert.equal(dynamicClient.port, 9222);
});

test('CdpClient re-resolves port on reconnect retry if initial connect fails', async () => {
  let callCount = 0;
  const portsUsed = [];
  const client = new CdpClient({
    portResolver: async () => {
      callCount += 1;
      return callCount === 1 ? 1111 : 2222;
    },
    discover: async (port) => {
      portsUsed.push(port);
      if (port === 1111) throw new Error('stale port');
      return { id: 'T3', webSocketDebuggerUrl: 'ws://127.0.0.1:2222/t3' };
    },
    wsFactory: () => {
      const emitter = new EventEmitter();
      emitter.send = () => {};
      emitter.close = () => {};
      process.nextTick(() => emitter.emit('open'));
      return emitter;
    }
  });
  await client.attach();
  assert.deepEqual(portsUsed, [1111, 2222]);
  assert.equal(client.port, 2222);
  assert.equal(client.statusSnapshot().port, 2222);
  client.close();
});

test('captureScreenshot sends Page.enable and Page.captureScreenshot and returns base64 data and default format', async () => {
  const { client, sockets } = harness();
  await client.attach();
  sockets[0].responder = (msg) => {
    if (msg.method === 'Page.enable') return { result: {} };
    if (msg.method === 'Page.captureScreenshot') {
      assert.equal(msg.params.format, 'png');
      return { result: { data: 'BASE64PNGDATA' } };
    }
    return null;
  };
  const result = await client.captureScreenshot();
  assert.deepEqual(result, { data: 'BASE64PNGDATA', format: 'png' });
  assert.ok(sockets[0].sent.some((m) => m.method === 'Page.enable'));
  assert.ok(sockets[0].sent.some((m) => m.method === 'Page.captureScreenshot'));
  client.close();
});

test('captureScreenshot forwards format, quality, and clip options', async () => {
  const { client, sockets } = harness();
  await client.attach();
  sockets[0].responder = (msg) => {
    if (msg.method === 'Page.enable') return { result: {} };
    if (msg.method === 'Page.captureScreenshot') {
      assert.equal(msg.params.format, 'jpeg');
      assert.equal(msg.params.quality, 80);
      assert.deepEqual(msg.params.clip, { x: 10, y: 20, width: 200, height: 150, scale: 1 });
      return { result: { data: 'BASE64JPEGDATA' } };
    }
    return null;
  };
  const result = await client.captureScreenshot({
    format: 'jpeg',
    quality: 80,
    clip: { x: 10, y: 20, width: 200, height: 150, scale: 1 }
  });
  assert.deepEqual(result, { data: 'BASE64JPEGDATA', format: 'jpeg' });
  client.close();
});

test('captureScreenshot defensively ignores Page.enable failure', async () => {
  const { client, sockets } = harness();
  await client.attach();
  sockets[0].responder = (msg) => {
    if (msg.method === 'Page.enable') return { error: { code: -32000, message: 'Page already enabled' } };
    if (msg.method === 'Page.captureScreenshot') return { result: { data: 'BASE64FALLBACK' } };
    return null;
  };
  const result = await client.captureScreenshot();
  assert.deepEqual(result, { data: 'BASE64FALLBACK', format: 'png' });
  client.close();
});

test('captureScreenshot propagates Page.captureScreenshot error', async () => {
  const { client, sockets } = harness();
  await client.attach();
  sockets[0].responder = (msg) => {
    if (msg.method === 'Page.enable') return { result: {} };
    if (msg.method === 'Page.captureScreenshot') return { error: { code: -32000, message: 'Unable to capture screenshot' } };
    return null;
  };
  await assert.rejects(client.captureScreenshot(), /Unable to capture screenshot/);
  client.close();
});

