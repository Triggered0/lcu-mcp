import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptReadyCheck } from '../src/workflow/matchmaking.js';

function createMockLcu({ getState = 'InProgress', playerResponse = 'None', getStatus = 200, postStatus = 200 } = {}) {
  const calls = {
    gets: [],
    posts: []
  };

  return {
    calls,
    get: async (path) => {
      calls.gets.push(path);
      if (getStatus !== 200) {
        return { status: getStatus, body: null };
      }
      return {
        status: 200,
        body: {
          state: getState,
          playerResponse
        }
      };
    },
    request: async (method, path, body) => {
      calls.posts.push({ method, path, body });
      if (postStatus >= 400) {
        return { status: postStatus, body: { message: 'Failed' } };
      }
      return { status: postStatus, body: null };
    }
  };
}

test('acceptReadyCheck throws when lcu is missing or invalid', async () => {
  await assert.rejects(
    async () => acceptReadyCheck(null),
    /LCU client is required/i
  );
  await assert.rejects(
    async () => acceptReadyCheck({}),
    /LCU client is required/i
  );
});

test('acceptReadyCheck returns failure when ready check state is not InProgress', async () => {
  const lcu = createMockLcu({ getState: 'None', playerResponse: 'None' });
  const result = await acceptReadyCheck(lcu);

  assert.equal(result.success, false);
  assert.equal(result.state, 'None');
  assert.equal(result.playerResponse, 'None');
  assert.match(result.message, /not currently in progress/i);
  assert.equal(lcu.calls.posts.length, 0);
});

test('acceptReadyCheck returns failure gracefully when GET ready-check returns 404', async () => {
  const lcu = createMockLcu({ getStatus: 404 });
  const result = await acceptReadyCheck(lcu);

  assert.equal(result.success, false);
  assert.equal(result.state, 'None');
  assert.equal(result.playerResponse, 'None');
  assert.match(result.message, /not currently in progress/i);
  assert.equal(lcu.calls.posts.length, 0);
});

test('acceptReadyCheck is idempotent when playerResponse is already Accepted', async () => {
  const lcu = createMockLcu({ getState: 'InProgress', playerResponse: 'Accepted' });
  const result = await acceptReadyCheck(lcu);

  assert.equal(result.success, true);
  assert.equal(result.state, 'InProgress');
  assert.equal(result.playerResponse, 'Accepted');
  assert.match(result.message, /already accepted/i);
  assert.equal(lcu.calls.posts.length, 0, 'Must not post accept if already accepted');
});

test('acceptReadyCheck successfully accepts active ready check', async () => {
  const lcu = createMockLcu({ getState: 'InProgress', playerResponse: 'None' });
  const result = await acceptReadyCheck(lcu);

  assert.equal(result.success, true);
  assert.equal(result.state, 'InProgress');
  assert.equal(result.playerResponse, 'Accepted');
  assert.match(result.message, /ready check accepted/i);
  assert.equal(lcu.calls.posts.length, 1);
  assert.equal(lcu.calls.posts[0].method, 'POST');
  assert.equal(lcu.calls.posts[0].path, '/lol-matchmaking/v1/ready-check/accept');
});

test('acceptReadyCheck throws when POST to accept fails', async () => {
  const lcu = createMockLcu({ getState: 'InProgress', playerResponse: 'None', postStatus: 500 });
  await assert.rejects(
    async () => acceptReadyCheck(lcu),
    /failed to accept ready check/i
  );
});
