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
