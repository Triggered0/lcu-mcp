import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fakeContext } from './helpers/context.js';
import { registerMatchAnalyticsTools } from '../src/tools/analytics_match.js';

test('lol_analytics_match_detail: parses objective and damage distribution', async () => {
  const ctx = fakeContext({
    lcu: {
      get: async (path) => {
        if (path === '/lol-match-history/v1/games/999') {
          return {
            status: 200,
            body: JSON.stringify({
              gameId: 999,
              gameDuration: 1800,
              gameMode: 'CLASSIC',
              teams: [
                { teamId: 100, win: 'Win', baronKills: 1, dragonKills: 3, towerKills: 8 },
                { teamId: 200, win: 'Fail', baronKills: 0, dragonKills: 1, towerKills: 2 }
              ],
              participantIdentities: [
                { participantId: 1, player: { summonerName: 'MidHero', puuid: 'p1' } },
                { participantId: 2, player: { summonerName: 'EnemyMid', puuid: 'p2' } }
              ],
              participants: [
                {
                  participantId: 1,
                  teamId: 100,
                  championId: 103,
                  stats: { totalDamageDealtToChampions: 30000, goldEarned: 15000, kills: 10, deaths: 1, assists: 5, visionScore: 25 }
                },
                {
                  participantId: 2,
                  teamId: 200,
                  championId: 238,
                  stats: { totalDamageDealtToChampions: 15000, goldEarned: 9000, kills: 2, deaths: 8, assists: 1, visionScore: 10 }
                }
              ]
            })
          };
        }
        return { status: 404, body: '{}' };
      }
    },
    staticData: {
      load: async () => [{ id: 103, name: 'Ahri' }, { id: 238, name: 'Zed' }]
    }
  });

  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerMatchAnalyticsTools(server, ctx);
  const tool = server._registeredTools['lol_analytics_match_detail'];
  assert.ok(tool);

  const res = await tool.handler({ gameId: 999 });
  assert.equal(res.isError, undefined);
  const data = JSON.parse(res.content[0].text);
  assert.equal(data.summary.gameId, 999);
  assert.equal(data.summary.winningTeam, 100);
  assert.equal(data.objectives.blueTeam.dragons, 3);
  assert.equal(data.players[0].championName, 'Ahri');
  assert.equal(data.players[0].damageSharePercent, 100);
});
