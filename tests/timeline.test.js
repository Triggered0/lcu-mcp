import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TimelineBuffer } from '../src/lcu/timeline.js';

// A deterministic clock: one millisecond per push.
function fakeClock(start = 1000) {
  let t = start;
  return { now: () => (t += 1), wall: () => t + 500_000 };
}

function make({ maxEntries = 10, maxBytes = Infinity } = {}) {
  return new TimelineBuffer({ maxEntries, maxBytes, clock: fakeClock() });
}

test('push stamps seq, ts and wallTs, and the entry cannot overwrite them', () => {
  const buffer = make();
  const stored = buffer.push({ kind: 'event', uri: '/a', seq: 999, ts: 0, wallTs: 0 });
  assert.equal(stored.seq, 1);
  assert.equal(stored.ts, 1001);
  assert.equal(stored.wallTs, 501_001);
});

test('the count budget evicts oldest first', () => {
  const buffer = make({ maxEntries: 3 });
  for (let i = 0; i < 5; i += 1) buffer.push({ kind: 'event', uri: '/a' });
  assert.equal(buffer.length, 3);
  assert.deepEqual(buffer.select({ limit: 100 }).entries.map((e) => e.seq), [3, 4, 5]);
  assert.equal(buffer.droppedTotal, 2);
});

test('the byte budget evicts before the count budget is reached', () => {
  const buffer = make({ maxEntries: 1000, maxBytes: 400 });
  for (let i = 0; i < 20; i += 1) buffer.push({ kind: 'event', uri: '/a', data: 'x'.repeat(50) });
  assert.ok(buffer.length < 20, 'byte budget should have evicted entries');
  assert.ok(buffer.bytes <= 400, `bytes ${buffer.bytes} should be within budget`);
  assert.ok(buffer.droppedTotal > 0);
});

test('a single oversized entry is kept rather than evicted forever', () => {
  const buffer = make({ maxEntries: 10, maxBytes: 10 });
  buffer.push({ kind: 'event', uri: '/a', data: 'x'.repeat(500) });
  assert.equal(buffer.length, 1);
});

test('dropped is reported relative to the caller cursor', () => {
  const buffer = make({ maxEntries: 3 });
  for (let i = 0; i < 10; i += 1) buffer.push({ kind: 'event', uri: '/a' });
  const { entries, dropped } = buffer.select({ cursor: 2, limit: 100 });
  assert.deepEqual(entries.map((e) => e.seq), [8, 9, 10]);
  assert.equal(dropped, 5); // seq 3..7 were evicted after the caller's cursor
});

test('a time range filters on ts', () => {
  const buffer = make();
  for (let i = 0; i < 5; i += 1) buffer.push({ kind: 'event', uri: '/a' });
  // ts values are 1001..1005
  const { entries } = buffer.select({ since: 1002, until: 1004, limit: 100 });
  assert.deepEqual(entries.map((e) => e.ts), [1002, 1003, 1004]);
});

test('kinds is the only filter that can exclude a lifecycle entry', () => {
  const buffer = make();
  buffer.push({ kind: 'open', port: 1 });
  buffer.push({ kind: 'event', uri: '/a' });
  buffer.push({ kind: 'close', code: 1006 });

  const all = buffer.select({ limit: 100 });
  assert.deepEqual(all.entries.map((e) => e.kind), ['open', 'event', 'close']);

  const only = buffer.select({ kinds: ['event'], limit: 100 });
  assert.deepEqual(only.entries.map((e) => e.kind), ['event']);
});

test('a predicate filters without disturbing cursor accounting', () => {
  const buffer = make();
  buffer.push({ kind: 'event', uri: '/keep' });
  buffer.push({ kind: 'event', uri: '/drop' });
  buffer.push({ kind: 'event', uri: '/keep' });
  const { entries, cursor } = buffer.select({
    predicate: (e) => e.uri === '/keep',
    limit: 100
  });
  assert.equal(entries.length, 2);
  assert.equal(cursor, 3); // the cursor tracks the real seq, not the filtered count
});

test('limit paginates and reports what remains', () => {
  const buffer = make();
  for (let i = 0; i < 6; i += 1) buffer.push({ kind: 'event', uri: '/a' });
  const { entries, cursor, remaining } = buffer.select({ limit: 2 });
  assert.deepEqual(entries.map((e) => e.seq), [1, 2]);
  assert.equal(cursor, 2);
  assert.equal(remaining, 4);
});

test('an empty result keeps the caller cursor', () => {
  const buffer = make();
  buffer.push({ kind: 'event', uri: '/a' });
  assert.equal(buffer.select({ cursor: 1, limit: 100 }).cursor, 1);
});

test('clear empties the buffer and the byte total but not the seq counter', () => {
  const buffer = make();
  buffer.push({ kind: 'event', uri: '/a' });
  buffer.clear();
  assert.equal(buffer.length, 0);
  assert.equal(buffer.bytes, 0);
  assert.equal(buffer.push({ kind: 'event', uri: '/a' }).seq, 2);
});
