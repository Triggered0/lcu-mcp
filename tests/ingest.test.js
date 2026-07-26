import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_DATA_BYTES, decodeFrame, matchesFilters, truncateData } from '../src/lcu/ingest.js';

test('absent or empty filters match every uri', () => {
  assert.equal(matchesFilters('/lol-gameflow/v1/session', []), true);
  assert.equal(matchesFilters('/lol-gameflow/v1/session', undefined), true);
});

test('filters match on uri prefix', () => {
  const filters = ['/lol-champ-select/', '/lol-matchmaking/'];
  assert.equal(matchesFilters('/lol-champ-select/v1/session', filters), true);
  assert.equal(matchesFilters('/lol-gameflow/v1/session', filters), false);
});

test('small data is not truncated', () => {
  const result = truncateData({ phase: 'ReadyCheck' });
  assert.deepEqual(result, { data: { phase: 'ReadyCheck' }, truncated: false });
});

test('oversized data becomes a truncated JSON string', () => {
  const big = { blob: 'x'.repeat(MAX_DATA_BYTES * 2) };
  const result = truncateData(big);
  assert.equal(result.truncated, true);
  assert.equal(typeof result.data, 'string');
  assert.equal(result.data.length, MAX_DATA_BYTES);
});

test('null and undefined data pass through', () => {
  assert.deepEqual(truncateData(null), { data: null, truncated: false });
  assert.deepEqual(truncateData(undefined), { data: undefined, truncated: false });
});

test('decodeFrame reads an OnJsonApiEvent frame', () => {
  const raw = JSON.stringify([8, 'OnJsonApiEvent', { eventType: 'Update', uri: '/lol-gameflow/v1/session', data: { phase: 'Lobby' } }]);
  assert.deepEqual(decodeFrame(raw), {
    eventType: 'Update',
    uri: '/lol-gameflow/v1/session',
    data: { phase: 'Lobby' }
  });
});

test('decodeFrame returns null for the empty subscribe ack', () => {
  assert.equal(decodeFrame(''), null);
  assert.equal(decodeFrame('   '), null);
  assert.equal(decodeFrame(Buffer.alloc(0)), null);
});

test('decodeFrame returns null for junk and non-event frames', () => {
  assert.equal(decodeFrame('not json'), null);
  assert.equal(decodeFrame(JSON.stringify([5, 'OnJsonApiEvent'])), null);
  assert.equal(decodeFrame(JSON.stringify({ eventType: 'Update' })), null);
});
