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
