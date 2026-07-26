import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALWAYS_ALLOWED, checkWrite } from '../src/allowlist.js';

const list = [
  'POST /lol-matchmaking/v1/ready-check/accept',
  'POST /lol-champ-select/v1/session/actions/*'
];

test('ALWAYS_ALLOWED is exported and holds exactly GET and HEAD', () => {
  assert.deepEqual([...ALWAYS_ALLOWED].sort(), ['GET', 'HEAD']);
});

test('GET and HEAD are always allowed', () => {
  assert.equal(checkWrite('GET', '/anything', []).allowed, true);
  assert.equal(checkWrite('head', '/anything', []).allowed, true);
});

test('exact entry allows the write', () => {
  assert.equal(checkWrite('POST', '/lol-matchmaking/v1/ready-check/accept', list).allowed, true);
});

test('method comparison is case-insensitive', () => {
  assert.equal(checkWrite('post', '/lol-matchmaking/v1/ready-check/accept', list).allowed, true);
});

test('path comparison is case-sensitive', () => {
  assert.equal(checkWrite('POST', '/LOL-matchmaking/v1/ready-check/accept', list).allowed, false);
});

test('trailing wildcard matches exactly one further segment', () => {
  assert.equal(checkWrite('PATCH', '/lol-champ-select/v1/session/actions/7', list).allowed, false);
  assert.equal(checkWrite('POST', '/lol-champ-select/v1/session/actions/7', list).allowed, true);
  assert.equal(checkWrite('POST', '/lol-champ-select/v1/session/actions/7/extra', list).allowed, false);
  assert.equal(checkWrite('POST', '/lol-champ-select/v1/session/actions/', list).allowed, false);
});

test('denial names the exact line to add', () => {
  const result = checkWrite('POST', '/lol-lobby/v2/lobby', list);
  assert.equal(result.allowed, false);
  assert.equal(result.line, 'POST /lol-lobby/v2/lobby');
  assert.match(result.message, /not on the write allowlist/);
  assert.match(result.message, /"POST \/lol-lobby\/v2\/lobby"/);
  assert.match(result.message, /writeAllowlist/);
});
