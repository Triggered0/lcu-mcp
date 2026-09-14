import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLobby } from '../src/workflow/lobby.js';

function createMockLcu({ currentLobby = null, lobbyStatus = 200, postLobbyStatus = 200, postSearchStatus = 200 } = {}) {
  const calls = {
    gets: [],
    posts: []
  };

  return {
    calls,
    get: async (path) => {
      calls.gets.push(path);
      if (path === '/lol-lobby/v2/lobby') {
        if (!currentLobby || lobbyStatus !== 200) {
          return { status: 404, body: null };
        }
        return { status: 200, body: currentLobby };
      }
      return { status: 404, body: null };
    },
    request: async (method, path, body) => {
      calls.posts.push({ method, path, body });
      if (path === '/lol-lobby/v2/lobby') {
        if (postLobbyStatus >= 400) return { status: postLobbyStatus, body: { message: 'Lobby failed' } };
        return { status: postLobbyStatus, body: { queueId: body?.queueId } };
      }
      if (path === '/lol-lobby/v2/lobby/matchmaking/search') {
        if (postSearchStatus >= 400) return { status: postSearchStatus, body: { message: 'Search failed' } };
        return { status: postSearchStatus, body: null };
      }
      return { status: 200, body: null };
    }
  };
}

test('createLobby throws when lcu client is missing or invalid', async () => {
  await assert.rejects(
    async () => createLobby(null, { queueId: 420 }),
    /LCU client is required/i
  );
});

test('createLobby throws when queueId is missing or not a number', async () => {
  const lcu = createMockLcu();
  await assert.rejects(
    async () => createLobby(lcu, {}),
    /queueId is required and must be a number/i
  );
  await assert.rejects(
    async () => createLobby(lcu, { queueId: 'invalid' }),
    /queueId is required and must be a number/i
  );
  await assert.rejects(
    async () => createLobby(lcu, { queueId: NaN }),
    /queueId is required and must be a number/i
  );
});

test('createLobby creates a lobby without starting matchmaking', async () => {
  const lcu = createMockLcu();
  const result = await createLobby(lcu, { queueId: 420, startMatchmaking: false });

  assert.equal(result.success, true);
  assert.equal(result.queueId, 420);
  assert.equal(result.matchmakingStarted, false);
  assert.match(result.message, /lobby created/i);

  assert.equal(lcu.calls.posts.length, 1);
  assert.equal(lcu.calls.posts[0].path, '/lol-lobby/v2/lobby');
  assert.deepEqual(lcu.calls.posts[0].body, { queueId: 420 });
});

test('createLobby creates a lobby and starts matchmaking when startMatchmaking is true', async () => {
  const lcu = createMockLcu();
  const result = await createLobby(lcu, { queueId: 440, startMatchmaking: true });

  assert.equal(result.success, true);
  assert.equal(result.queueId, 440);
  assert.equal(result.matchmakingStarted, true);
  assert.match(result.message, /lobby created/i);

  assert.equal(lcu.calls.posts.length, 2);
  assert.equal(lcu.calls.posts[0].path, '/lol-lobby/v2/lobby');
  assert.equal(lcu.calls.posts[1].path, '/lol-lobby/v2/lobby/matchmaking/search');
});

test('createLobby is idempotent when already in lobby with the same queueId', async () => {
  const currentLobby = {
    gameConfig: { queueId: 420 }
  };
  const lcu = createMockLcu({ currentLobby });

  const result = await createLobby(lcu, { queueId: 420, startMatchmaking: false });
  assert.equal(result.success, true);
  assert.equal(result.queueId, 420);
  assert.equal(result.matchmakingStarted, false);
  assert.match(result.message, /already in lobby/i);

  // No POST to create lobby should be made
  assert.equal(lcu.calls.posts.length, 0);
});

test('createLobby starts matchmaking if already in lobby with the same queueId and startMatchmaking is true', async () => {
  const currentLobby = {
    gameConfig: { queueId: 420 }
  };
  const lcu = createMockLcu({ currentLobby });

  const result = await createLobby(lcu, { queueId: 420, startMatchmaking: true });
  assert.equal(result.success, true);
  assert.equal(result.queueId, 420);
  assert.equal(result.matchmakingStarted, true);

  // Only the search POST should be made
  assert.equal(lcu.calls.posts.length, 1);
  assert.equal(lcu.calls.posts[0].path, '/lol-lobby/v2/lobby/matchmaking/search');
});

test('createLobby throws when POST /lol-lobby/v2/lobby fails', async () => {
  const lcu = createMockLcu({ postLobbyStatus: 500 });
  await assert.rejects(
    async () => createLobby(lcu, { queueId: 420 }),
    /failed to create lobby/i
  );
});

test('createLobby throws when search POST fails', async () => {
  const lcu = createMockLcu({ postSearchStatus: 500 });
  await assert.rejects(
    async () => createLobby(lcu, { queueId: 420, startMatchmaking: true }),
    /failed to start matchmaking/i
  );
});
