import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fakeContext } from './helpers/context.js';
import { registerPlayerAnalyticsTools } from '../src/tools/analytics_player.js';

test('lol_analytics_player: aggregates ranked stats and recent match performance', async () => {
  const ctx = fakeContext({
    lcu: {
      get: async (path) => {
        if (path === '/lol-summoner/v1/current-summoner') {
          return { status: 200, body: JSON.stringify({ puuid: 'puuid-1', gameName: 'Faker', tagLine: 'T1', summonerLevel: 500 }) };
        }
        if (path === '/lol-ranked/v1/ranked-stats/puuid-1') {
          return {
            status: 200,
            body: JSON.stringify({
              queues: [
                { queueType: 'RANKED_SOLO_5x5', tier: 'CHALLENGER', division: 'I', leaguePoints: 1250, wins: 150, losses: 50 }
              ]
            })
          };
        }
        if (path.startsWith('/lol-match-history/v1/products/lol/puuid-1/matches')) {
          return {
            status: 200,
            body: JSON.stringify({
              games: {
                games: [
                  {
                    gameId: 101,
                    gameDuration: 1800,
                    participants: [{ championId: 103, stats: { win: true, kills: 10, deaths: 2, assists: 8, totalMinionsKilled: 250, neutralMinionsKilled: 20 } }]
                  },
                  {
                    gameId: 102,
                    gameDuration: 1200,
                    participants: [{ championId: 103, stats: { win: false, kills: 2, deaths: 4, assists: 3, totalMinionsKilled: 150, neutralMinionsKilled: 10 } }]
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
      load: async () => [{ id: 103, name: 'Ahri' }]
    }
  });

  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerPlayerAnalyticsTools(server, ctx);
  const tool = server._registeredTools['lol_analytics_player'];
  assert.ok(tool);

  const res = await tool.handler({});
  assert.equal(res.isError, undefined);
  const data = JSON.parse(res.content[0].text);
  assert.equal(data.summoner.gameName, 'Faker');
  assert.equal(data.ranked.soloQueue.tier, 'CHALLENGER');
  assert.equal(data.recentPerformance.winratePercent, 50);
  assert.equal(data.recentPerformance.averageKda, '3.83');
  assert.equal(data.championPool[0].championName, 'Ahri');
});
