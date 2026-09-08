import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { NdjsonSink } from '../src/lcu/ndjson.js';

class FakeStream extends EventEmitter {
  written = [];
  ended = false;
  write(chunk) {
    this.written.push(chunk);
    return true;
  }
  end() {
    this.ended = true;
  }
}

function harness() {
  const stream = new FakeStream();
  const errors = [];
  const sink = new NdjsonSink({
    path: 'C:\\tmp\\rec.ndjson',
    onError: (message) => errors.push(message),
    createStream: () => stream
  });
  return { sink, stream, errors };
}

test('each entry is written as one JSON line', () => {
  const { sink, stream } = harness();
  sink.write({ kind: 'event', uri: '/a', seq: 1 });
  sink.write({ kind: 'close', code: 1006, seq: 2 });
  assert.equal(stream.written.length, 2);
  assert.equal(JSON.parse(stream.written[0]).uri, '/a');
  assert.ok(stream.written[0].endsWith('\n'));
  assert.equal(JSON.parse(stream.written[1]).code, 1006);
});

test('a stream error disables the sink and reports once', () => {
  const { sink, stream, errors } = harness();
  stream.emit('error', new Error('ENOSPC: no space left on device'));

  assert.equal(sink.disabled, true);
  assert.equal(sink.write({ kind: 'event' }), false);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /ENOSPC/);
});

test('a write that throws disables the sink rather than propagating', () => {
  const { sink, stream, errors } = harness();
  stream.write = () => {
    throw new Error('stream destroyed');
  };
  assert.doesNotThrow(() => sink.write({ kind: 'event' }));
  assert.equal(sink.disabled, true);
  assert.match(errors[0], /stream destroyed/);
});

test('close ends the stream and stops accepting writes', () => {
  const { sink, stream } = harness();
  sink.close();
  assert.equal(stream.ended, true);
  assert.equal(sink.write({ kind: 'event' }), false);
});
