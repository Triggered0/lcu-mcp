import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fakeContext } from './helpers/context.js';
import { registerWorkflowPostgameTools } from '../src/tools/workflow_postgame.js';

test('lol_workflow_play_again: triggers lobby recreation after game', async () => {
  let playAgainCalled = false;
  const ctx = fakeContext({
    config: {
      writeAllowlist: ['POST /lol-lobby/v2/play-again']
    },
    lcu: {
      get: async (path) => {
        if (path === '/lol-gameflow/v1/gameflow-phase') return { status: 200, body: '"EndOfGame"' };
        return { status: 404, body: '{}' };
      },
      request: async (method, path) => {
        if (method === 'POST' && path === '/lol-lobby/v2/play-again') {
          playAgainCalled = true;
          return { status: 200, body: '{}' };
        }
        return { status: 400, body: '' };
      }
    }
  });

  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerWorkflowPostgameTools(server, ctx);
  const tool = server._registeredTools['lol_workflow_play_again'];
  assert.ok(tool);

  const res = await tool.handler({});
  assert.equal(res.isError, undefined);
  assert.equal(playAgainCalled, true);
});

test('lol_workflow_honor: votes for teammate on ballot', async () => {
  let votedBody = null;
  const ctx = fakeContext({
    config: {
      writeAllowlist: ['POST /lol-honor/v1/honor']
    },
    lcu: {
      get: async (path) => {
        if (path === '/lol-honor/v1/ballot') {
          return {
            status: 200,
            body: JSON.stringify({
              eligiblePlayers: [{ summonerId: 111, summonerName: 'SupportHero' }]
            })
          };
        }
        return { status: 404, body: '{}' };
      },
      request: async (method, path, body) => {
        if (method === 'POST' && path === '/lol-honor/v1/honor') {
          votedBody = JSON.parse(body);
          return { status: 204, body: '' };
        }
        return { status: 400, body: '' };
      }
    }
  });

  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerWorkflowPostgameTools(server, ctx);
  const tool = server._registeredTools['lol_workflow_honor'];
  assert.ok(tool);

  const res = await tool.handler({ target: 'SupportHero', honorCategory: 'HEART' });
  assert.equal(res.isError, undefined);
  assert.equal(votedBody.honorCategory, 'HEART');
  assert.equal(votedBody.summonerId, 111);
});
