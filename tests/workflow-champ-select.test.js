import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickOrBanChampion } from '../src/workflow/champ_select.js';

function createMockStaticData(champions = [{ id: 157, name: 'Yasuo' }, { id: 266, name: 'Aatrox' }]) {
  return {
    load: async (kind) => {
      if (kind === 'champions') return champions;
      return [];
    },
    query: async ({ kind, query } = {}) => {
      if (kind !== 'champions') return { entries: [] };
      const matched = champions.filter((c) =>
        c.name.toLowerCase().includes((query || '').toLowerCase())
      );
      return { entries: matched };
    }
  };
}

function createMockLcu({ session = null, sessionStatus = 200, patchStatus = 204 } = {}) {
  const calls = {
    gets: [],
    patches: []
  };

  return {
    calls,
    get: async (path) => {
      calls.gets.push(path);
      if (sessionStatus !== 200) {
        return { status: sessionStatus, body: null };
      }
      return { status: 200, body: session };
    },
    request: async (method, path, body) => {
      if (method === 'PATCH') {
        calls.patches.push({ method, path, body });
        if (patchStatus >= 400) {
          return { status: patchStatus, body: { message: 'Action failed' } };
        }
        return { status: patchStatus, body: null };
      }
      return { status: 200, body: null };
    }
  };
}

test('pickOrBanChampion throws when champion is missing or empty', async () => {
  const lcu = createMockLcu();
  const staticData = createMockStaticData();

  await assert.rejects(
    async () => pickOrBanChampion(lcu, staticData, {}),
    /champion is required/i
  );
  await assert.rejects(
    async () => pickOrBanChampion(lcu, staticData, { champion: '' }),
    /champion is required/i
  );
});

test('pickOrBanChampion throws when type is not pick or ban', async () => {
  const lcu = createMockLcu();
  const staticData = createMockStaticData();

  await assert.rejects(
    async () => pickOrBanChampion(lcu, staticData, { champion: 157, type: 'invalid' }),
    /type must be 'pick' or 'ban'/i
  );
});

test('pickOrBanChampion throws when lcu is missing', async () => {
  const staticData = createMockStaticData();
  await assert.rejects(
    async () => pickOrBanChampion(null, staticData, { champion: 157 }),
    /LCU client is required/i
  );
});

test('pickOrBanChampion returns inChampSelect: false when session returns 404', async () => {
  const lcu = createMockLcu({ sessionStatus: 404 });
  const staticData = createMockStaticData();

  const result = await pickOrBanChampion(lcu, staticData, { champion: 157 });
  assert.equal(result.success, false);
  assert.equal(result.inChampSelect, false);
  assert.match(result.message, /not currently in champion select/i);
  assert.equal(lcu.calls.patches.length, 0);
});

test('pickOrBanChampion returns inChampSelect: false when session body is empty', async () => {
  const lcu = createMockLcu({ session: null });
  const staticData = createMockStaticData();

  const result = await pickOrBanChampion(lcu, staticData, { champion: 157 });
  assert.equal(result.success, false);
  assert.equal(result.inChampSelect, false);
  assert.match(result.message, /not currently in champion select/i);
});

test('pickOrBanChampion returns failure when no active action is found for local player', async () => {
  const session = {
    localPlayerCellId: 3,
    actions: [
      [
        { id: 10, actorCellId: 3, type: 'pick', completed: true, isInProgress: false },
        { id: 11, actorCellId: 4, type: 'pick', completed: false, isInProgress: true }
      ]
    ]
  };
  const lcu = createMockLcu({ session });
  const staticData = createMockStaticData();

  const result = await pickOrBanChampion(lcu, staticData, { champion: 157, type: 'pick' });
  assert.equal(result.success, false);
  assert.equal(result.inChampSelect, true);
  assert.match(result.message, /no active pick action found/i);
  assert.equal(lcu.calls.patches.length, 0);
});

test('pickOrBanChampion resolves champion by numeric ID and locks in', async () => {
  const session = {
    localPlayerCellId: 2,
    actions: [
      [
        { id: 42, actorCellId: 2, type: 'pick', completed: false, isInProgress: true }
      ]
    ]
  };
  const lcu = createMockLcu({ session });
  const staticData = createMockStaticData();

  const result = await pickOrBanChampion(lcu, staticData, { champion: 157, completed: true });
  assert.equal(result.success, true);
  assert.equal(result.inChampSelect, true);
  assert.equal(result.actionId, 42);
  assert.equal(result.type, 'pick');
  assert.equal(result.championId, 157);
  assert.equal(result.championName, 'Yasuo');
  assert.equal(result.completed, true);
  assert.match(result.message, /locked in/i);

  assert.equal(lcu.calls.patches.length, 1);
  assert.equal(lcu.calls.patches[0].path, '/lol-champ-select/v1/session/actions/42');
  assert.deepEqual(lcu.calls.patches[0].body, { championId: 157, completed: true });
});

test('pickOrBanChampion resolves champion by case-insensitive name string', async () => {
  const session = {
    localPlayerCellId: 0,
    actions: [
      [
        { id: 99, actorCellId: 0, type: 'pick', completed: false }
      ]
    ]
  };
  const lcu = createMockLcu({ session });
  const staticData = createMockStaticData();

  const result = await pickOrBanChampion(lcu, staticData, { champion: 'aAtRoX', completed: true });
  assert.equal(result.success, true);
  assert.equal(result.championId, 266);
  assert.equal(result.championName, 'Aatrox');
  assert.equal(result.actionId, 99);
  assert.deepEqual(lcu.calls.patches[0].body, { championId: 266, completed: true });
});

test('pickOrBanChampion throws when champion name cannot be resolved', async () => {
  const session = {
    localPlayerCellId: 0,
    actions: [[{ id: 1, actorCellId: 0, type: 'pick', completed: false }]]
  };
  const lcu = createMockLcu({ session });
  const staticData = createMockStaticData();

  await assert.rejects(
    async () => pickOrBanChampion(lcu, staticData, { champion: 'NonExistentChamp' }),
    /champion not found/i
  );
});

test('pickOrBanChampion supports ban action and hovering without locking in', async () => {
  const session = {
    localPlayerCellId: 1,
    actions: [
      [
        { id: 77, actorCellId: 1, type: 'ban', completed: false, isInProgress: true }
      ]
    ]
  };
  const lcu = createMockLcu({ session });
  const staticData = createMockStaticData();

  const result = await pickOrBanChampion(lcu, staticData, { champion: 157, type: 'ban', completed: false });
  assert.equal(result.success, true);
  assert.equal(result.type, 'ban');
  assert.equal(result.completed, false);
  assert.match(result.message, /hovered/i);
  assert.deepEqual(lcu.calls.patches[0].body, { championId: 157, completed: false });
});

test('pickOrBanChampion handles flat 1D actions array structure', async () => {
  const session = {
    localPlayerCellId: 5,
    actions: [
      { id: 88, actorCellId: 5, type: 'pick', completed: false }
    ]
  };
  const lcu = createMockLcu({ session });
  const staticData = createMockStaticData();

  const result = await pickOrBanChampion(lcu, staticData, { champion: 266 });
  assert.equal(result.success, true);
  assert.equal(result.actionId, 88);
});
