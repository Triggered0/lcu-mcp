import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fakeContext } from './helpers/context.js';
import { registerMatchHistoryTools } from '../src/tools/analytics_history.js';

test('lol_analytics_match_history: returns token-efficient compact match rows', async () => {
  const ctx = fakeContext({
    lcu: {
      get: async (path) => {
        if (path === '/lol-summoner/v1/current-summoner') {
          return { status: 200, body: JSON.stringify({ puuid: 'puuid-1' }) };
        }
        if (path.startsWith('/lol-match-history/v1/products/lol/puuid-1/matches')) {
          return {
            status: 200,
            body: JSON.stringify({
              games: {
                games: [
                  {
                    gameId: 501,
                    gameCreationDate: '2026-09-29T10:00:00Z',
                    gameDuration: 1500,
                    queueId: 420,
                    participants: [
                      {
                        championId: 67,
                        stats: { win: true, kills: 8, deaths: 1, assists: 5, totalMinionsKilled: 210, neutralMinionsKilled: 12 }
                      }
                    ]
                  }
                ]
              }
            })
          };
        }
        return { status: 404, body: '{}' };
      }
    },
    staticData: {
      load: async () => [{ id: 67, name: 'Vayne' }]
    }
  });

  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerMatchHistoryTools(server, ctx);
  const tool = server._registeredTools['lol_analytics_match_history'];
  assert.ok(tool);

  const res = await tool.handler({ limit: 5 });
  assert.equal(res.isError, undefined);
  const data = JSON.parse(res.content[0].text);
  assert.equal(data.totalMatches, 1);
  assert.equal(data.matches[0].championName, 'Vayne');
  assert.equal(data.matches[0].result, 'WIN');
  assert.equal(data.matches[0].kda, '8/1/5');
});
