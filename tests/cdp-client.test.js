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
  assert.equal(await client.evaluate('1 + 41'), 42);
  client.close();
});

test('evaluate surfaces a page exception as an error', async () => {
  const { client, sockets } = harness();
  await client.attach();
  sockets[0].responder = () => ({
    result: { exceptionDetails: { exception: { description: 'ReferenceError: nope is not defined' } } }
  });
  await assert.rejects(client.evaluate('nope'), /ReferenceError: nope is not defined/);
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
