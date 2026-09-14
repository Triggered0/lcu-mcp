import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LcuStaticService, STATIC_KINDS } from '../src/lcu/static.js';

function createClient(docs) {
  const calls = [];
  return {
    calls,
    get: async (path) => {
      calls.push(path);
      if (!(path in docs)) return { status: 404, body: null };
      return { status: 200, body: docs[path] };
    }
  };
}

const CHAMPIONS = '/lol-game-data/assets/v1/champion-summary.json';
const ITEMS = '/lol-game-data/assets/v1/items.json';

test('STATIC_KINDS lists the six supported documents', () => {
  assert.deepEqual([...STATIC_KINDS].sort(), [
    'champions',
    'items',
    'maps',
    'perks',
    'queues',
    'summonerSpells'
  ]);
});

test('load fetches the document for a kind', async () => {
  const client = createClient({ [CHAMPIONS]: [{ id: 157, name: 'Yasuo' }] });
  const service = new LcuStaticService({ client });

  const entries = await service.load('champions');

  assert.deepEqual(entries, [{ id: 157, name: 'Yasuo' }]);
  assert.deepEqual(client.calls, [CHAMPIONS]);
});

test('load caches per kind and does not refetch', async () => {
  const client = createClient({ [CHAMPIONS]: [{ id: 157, name: 'Yasuo' }] });
  const service = new LcuStaticService({ client });

  await service.load('champions');
  await service.load('champions');

  assert.deepEqual(client.calls, [CHAMPIONS]);
});

test('load of one kind does not fetch another kind', async () => {
  const client = createClient({
    [CHAMPIONS]: [{ id: 157, name: 'Yasuo' }],
    [ITEMS]: [{ id: 1004, name: 'Faerie Charm' }]
  });
  const service = new LcuStaticService({ client });

  await service.load('champions');

  assert.deepEqual(client.calls, [CHAMPIONS], 'items.json is 667 KB and must not be fetched eagerly');
});

test('refresh re-fetches the document', async () => {
  const client = createClient({ [CHAMPIONS]: [{ id: 157, name: 'Yasuo' }] });
  const service = new LcuStaticService({ client });

  await service.load('champions');
  await service.load('champions', { refresh: true });

  assert.deepEqual(client.calls, [CHAMPIONS, CHAMPIONS]);
});

test('load parses a string body', async () => {
  const client = createClient({ [CHAMPIONS]: JSON.stringify([{ id: 1, name: 'Annie' }]) });
  const service = new LcuStaticService({ client });

  assert.deepEqual(await service.load('champions'), [{ id: 1, name: 'Annie' }]);
});

test('load rejects an unknown kind', async () => {
  const service = new LcuStaticService({ client: createClient({}) });
  await assert.rejects(() => service.load('runes'), /Unknown static data kind: runes/);
});

test('load surfaces an HTTP error', async () => {
  const service = new LcuStaticService({ client: createClient({}) });
  await assert.rejects(() => service.load('champions'), /failed: HTTP 404/);
});

test('load rejects a document that is not an array', async () => {
  const client = createClient({ [CHAMPIONS]: { nope: true } });
  const service = new LcuStaticService({ client });
  await assert.rejects(() => service.load('champions'), /did not return a JSON array/);
});

test('load requires a client', async () => {
  const service = new LcuStaticService({});
  await assert.rejects(() => service.load('champions'), /LCU client is required/);
});

const ROSTER = [
  { id: -1, name: 'None', alias: 'None', roles: [] },
  { id: 1, name: 'Annie', alias: 'Annie', roles: ['mage', 'support'] },
  { id: 157, name: 'Yasuo', alias: 'Yasuo', roles: ['fighter', 'assassin'] },
  { id: 800, name: 'Mel', alias: 'Mel', roles: ['mage'] }
];

function rosterService() {
  return new LcuStaticService({ client: createClient({ [CHAMPIONS]: ROSTER }) });
}

test('query by ids returns the matching entries projected to id and name', async () => {
  const result = await rosterService().query({ kind: 'champions', ids: [157] });

  assert.equal(result.kind, 'champions');
  assert.equal(result.total, 4);
  assert.equal(result.count, 1);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.entries, [{ id: 157, name: 'Yasuo' }]);
  assert.deepEqual(result.missing, []);
});

test('query reports ids with no matching entry', async () => {
  const result = await rosterService().query({ kind: 'champions', ids: [157, 99999] });

  assert.deepEqual(result.entries, [{ id: 157, name: 'Yasuo' }]);
  assert.deepEqual(result.missing, [99999], 'a dropped id would invite a false conclusion');
});

test('query resolves sentinel ids rather than filtering them out', async () => {
  const result = await rosterService().query({ kind: 'champions', ids: [-1] });

  assert.deepEqual(result.entries, [{ id: -1, name: 'None' }]);
  assert.deepEqual(result.missing, []);
});

test('query matches names case-insensitively on a substring', async () => {
  const result = await rosterService().query({ kind: 'champions', query: 'ya' });

  assert.deepEqual(result.entries, [{ id: 157, name: 'Yasuo' }]);
});

test('query omits missing when no ids were supplied', async () => {
  const result = await rosterService().query({ kind: 'champions', query: 'ya' });
  assert.equal('missing' in result, false);
});

test('ids and query compose as a conjunction', async () => {
  const result = await rosterService().query({ kind: 'champions', ids: [1, 157], query: 'yas' });

  assert.deepEqual(result.entries, [{ id: 157, name: 'Yasuo' }]);
  assert.deepEqual(result.missing, [], 'Annie was filtered by query, not missing from the document');
});

test('fields widens the projection and ignores unknown keys', async () => {
  const result = await rosterService().query({
    kind: 'champions',
    ids: [157],
    fields: ['roles', 'nonexistent']
  });

  assert.deepEqual(result.entries, [{ id: 157, name: 'Yasuo', roles: ['fighter', 'assassin'] }]);
});

test('limit truncates and offset pages past it', async () => {
  const first = await rosterService().query({ kind: 'champions', limit: 2 });
  assert.equal(first.count, 2);
  assert.equal(first.truncated, true);
  assert.deepEqual(first.entries.map((e) => e.id), [-1, 1]);

  const second = await rosterService().query({ kind: 'champions', limit: 2, offset: 2 });
  assert.equal(second.truncated, false);
  assert.deepEqual(second.entries.map((e) => e.id), [157, 800]);
});

test('an offset past the end returns nothing and is not truncated', async () => {
  const result = await rosterService().query({ kind: 'champions', limit: 10, offset: 99 });

  assert.equal(result.count, 0);
  assert.equal(result.truncated, false);
});

test('query with no filters returns the first page plus the true total', async () => {
  const result = await rosterService().query({ kind: 'champions' });

  assert.equal(result.total, 4);
  assert.equal(result.count, 4);
  assert.equal(result.truncated, false);
});

test('query forwards refresh to load', async () => {
  const client = createClient({ [CHAMPIONS]: ROSTER });
  const service = new LcuStaticService({ client });

  await service.query({ kind: 'champions' });
  await service.query({ kind: 'champions', refresh: true });

  assert.deepEqual(client.calls, [CHAMPIONS, CHAMPIONS]);
});
