import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RingBuffer } from '../src/lcu/buffer.js';

function fill(buffer, count, uri = '/lol-gameflow/v1/session') {
  for (let i = 0; i < count; i += 1) buffer.push({ eventType: 'Update', uri, data: i });
}

test('an event carrying seq or ts cannot overwrite the buffer numbering', () => {
  const buffer = new RingBuffer(10);
  const stored = buffer.push({ uri: '/a', seq: 999, ts: 0 });
  assert.equal(stored.seq, 1);
  assert.notEqual(stored.ts, 0);
  assert.equal(buffer.since(0).cursor, 1);
});

test('a negative cursor is clamped instead of inflating dropped', () => {
  const buffer = new RingBuffer(10);
  fill(buffer, 3);
  const result = buffer.since(-5);
  assert.equal(result.dropped, 0);
  assert.equal(result.entries.length, 3);
  assert.equal(result.cursor, 3);
});

test('push assigns increasing seq numbers starting at 1', () => {
  const buffer = new RingBuffer(10);
  assert.equal(buffer.push({ uri: '/a' }).seq, 1);
  assert.equal(buffer.push({ uri: '/a' }).seq, 2);
  assert.ok(typeof buffer.push({ uri: '/a' }).ts === 'number');
});

test('oldest entries are evicted on overflow', () => {
  const buffer = new RingBuffer(3);
  fill(buffer, 5);
  assert.equal(buffer.length, 3);
  const { entries } = buffer.since(0, 100);
  assert.deepEqual(entries.map((e) => e.seq), [3, 4, 5]);
});

test('since returns only entries after the cursor', () => {
  const buffer = new RingBuffer(10);
  fill(buffer, 5);
  const { entries, cursor } = buffer.since(3, 100);
  assert.deepEqual(entries.map((e) => e.seq), [4, 5]);
  assert.equal(cursor, 5);
});

test('dropped counts entries evicted past the cursor', () => {
  const buffer = new RingBuffer(3);
  fill(buffer, 10);
  const { dropped, entries } = buffer.since(2, 100);
  assert.equal(dropped, 5); // seq 3..7 evicted, oldest retained is 8
  assert.deepEqual(entries.map((e) => e.seq), [8, 9, 10]);
});

test('dropped is zero when nothing was evicted past the cursor', () => {
  const buffer = new RingBuffer(10);
  fill(buffer, 4);
  assert.equal(buffer.since(4, 100).dropped, 0);
});

test('limit caps the page and remaining reports the rest', () => {
  const buffer = new RingBuffer(10);
  fill(buffer, 6);
  const { entries, cursor, remaining } = buffer.since(0, 2);
  assert.deepEqual(entries.map((e) => e.seq), [1, 2]);
  assert.equal(cursor, 2);
  assert.equal(remaining, 4);
});

test('an empty result keeps the caller cursor', () => {
  const buffer = new RingBuffer(10);
  fill(buffer, 3);
  assert.equal(buffer.since(3, 100).cursor, 3);
  assert.equal(new RingBuffer(10).since(0, 100).cursor, 0);
});

test('filter applies a URI prefix at poll time', () => {
  const buffer = new RingBuffer(10);
  fill(buffer, 2, '/lol-champ-select/v1/session');
  fill(buffer, 2, '/lol-gameflow/v1/session');
  const { entries } = buffer.since(0, 100, '/lol-champ-select/');
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.uri.startsWith('/lol-champ-select/')));
});

test('clear empties the buffer but not the seq counter', () => {
  const buffer = new RingBuffer(10);
  fill(buffer, 3);
  buffer.clear();
  assert.equal(buffer.length, 0);
  assert.equal(buffer.push({ uri: '/a' }).seq, 4);
});
