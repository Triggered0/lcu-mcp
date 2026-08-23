import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENDPOINTS, GROUPS, filterEndpoints } from '../src/tools/curated.js';

test('every entry has the required shape', () => {
  assert.ok(ENDPOINTS.length >= 30, `expected the full curated table, got ${ENDPOINTS.length}`);
  for (const entry of ENDPOINTS) {
    assert.ok(entry.path.startsWith('/'), `${entry.path} must start with /`);
    assert.match(entry.method, /^(GET|POST|PATCH|PUT|DELETE)$/);
    assert.ok(entry.group.length > 0);
    assert.ok(entry.description.length > 0);
  }
});

test('the spec anchors are present', () => {
  const paths = ENDPOINTS.map((e) => e.path);
  for (const path of [
    '/lol-gameflow/v1/gameflow-phase',
    '/lol-champ-select/v1/session',
    '/lol-summoner/v1/current-summoner',
    '/lol-matchmaking/v1/ready-check/accept',
    '/riotclient/region-locale'
  ]) {
    assert.ok(paths.includes(path), `${path} missing from the curated table`);
  }
});

test('paths are unique per method', () => {
  const keys = ENDPOINTS.map((e) => `${e.method} ${e.path}`);
  assert.equal(new Set(keys).size, keys.length);
});

test('filterEndpoints matches path, group, and description case-insensitively', () => {
  assert.equal(filterEndpoints().length, ENDPOINTS.length);
  assert.equal(filterEndpoints('').length, ENDPOINTS.length);
  assert.ok(filterEndpoints('champ-select').every((e) => `${e.path} ${e.group} ${e.description}`.toLowerCase().includes('champ-select')));
  assert.ok(filterEndpoints('CHAMP-SELECT').length > 0);
  assert.equal(filterEndpoints('no-such-endpoint-anywhere').length, 0);
});

test('GROUPS lists each group once', () => {
  assert.equal(new Set(GROUPS).size, GROUPS.length);
  assert.ok(GROUPS.includes('gameflow'));
});

test('the table is immutable', () => {
  assert.throws(() => ENDPOINTS.push({}), TypeError);
});
