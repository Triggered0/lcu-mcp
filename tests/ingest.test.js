import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_DATA_BYTES, decodeFrame, matchesFilters, truncateData } from '../src/lcu/ingest.js';

test('a Buffer frame decodes like a string frame', () => {
  // The `ws` library hands over a Buffer unless told otherwise.
  const raw = Buffer.from(JSON.stringify([8, 'OnJsonApiEvent', { eventType: 'Update', uri: '/x', data: 1 }]));
  assert.equal(decodeFrame(raw)?.uri, '/x');
  assert.equal(decodeFrame(Buffer.alloc(0)), null);
});

test('the right opcode with the wrong event name is not an event', () => {
  assert.equal(decodeFrame(JSON.stringify([8, 'OnJsonApiEvent_x', { uri: '/x' }])), null);
  assert.equal(decodeFrame(JSON.stringify([8, 'OnJsonApiEvent', null])), null);
  assert.equal(decodeFrame(JSON.stringify([8, 'OnJsonApiEvent', 'nope'])), null);
});

test('absent or empty filters match every uri', () => {
  assert.equal(matchesFilters('/lol-gameflow/v1/session', []), true);
  assert.equal(matchesFilters('/lol-gameflow/v1/session', undefined), true);
});

test('filters match on uri prefix', () => {
  const filters = ['/lol-champ-select/', '/lol-matchmaking/'];
  assert.equal(matchesFilters('/lol-champ-select/v1/session', filters), true);
  assert.equal(matchesFilters('/lol-gameflow/v1/session', filters), false);
});

test('a prefix without a trailing slash also matches a sibling route', () => {
  // Documented consequence of prefix matching: a caller who wants only one
  // route ends its filter with a slash.
  assert.equal(matchesFilters('/lol-champ-select-legacy/v1/x', ['/lol-champ-select']), true);
  assert.equal(matchesFilters('/lol-champ-select-legacy/v1/x', ['/lol-champ-select/']), false);
  assert.equal(matchesFilters(undefined, ['/lol-champ-select/']), false);
});

test('the cap is measured in bytes, not characters', () => {
  // 2000 Korean characters serialise to ~6000 UTF-8 bytes: a character-count
  // cap would call this untruncated and hand ~6 KB to the buffer.
  const result = truncateData({ note: '한'.repeat(2000) });
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.data, 'utf8') <= MAX_DATA_BYTES);
  assert.ok(!result.data.includes('�'), 'must not end mid-character');
});

test('unserialisable data is reported, not thrown', () => {
  const circular = { name: 'lobby' };
  circular.self = circular;
  assert.deepEqual(truncateData(circular), { data: '[unserialisable]', truncated: true });
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
