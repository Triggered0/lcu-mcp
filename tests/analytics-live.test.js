import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fakeContext } from './helpers/context.js';
import { registerLiveAnalyticsTools } from '../src/tools/analytics_live.js';

test('lol_analytics_live_combat: extracts lane differentials and clock status', async () => {
  const ctx = fakeContext({
    gameClient: {
      isGameRunning: async () => true,
      getAllGameData: async () => ({
        gameData: { gameTime: 1250.5, gameMode: 'CLASSIC' },
        activePlayer: { summonerName: 'MidHero', championStats: { currentGold: 850 } },
        allPlayers: [
          { summonerName: 'MidHero', team: 'ORDER', level: 12, scores: { kills: 3, deaths: 0, assists: 2, creepScore: 180 } },
          { summonerName: 'EnemyMid', team: 'CHAOS', level: 11, scores: { kills: 0, deaths: 3, assists: 1, creepScore: 140 } }
        ],
        events: { Events: [] }
      })
    }
  });

  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerLiveAnalyticsTools(server, ctx);
  const tool = server._registeredTools['lol_analytics_live_combat'];
  assert.ok(tool);

  const res = await tool.handler({});
  assert.equal(res.isError, undefined);
  const data = JSON.parse(res.content[0].text);
  assert.equal(data.inGame, true);
  assert.equal(data.gameClock, '20m 50s');
  assert.equal(data.teams.order.totalKills, 3);
  assert.equal(data.teams.chaos.totalKills, 0);
});
