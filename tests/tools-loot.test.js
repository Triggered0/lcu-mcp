import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fakeContext } from './helpers/context.js';
import { registerLootTools } from '../src/tools/loot.js';

test('lol_analytics_loot_summary: calculates essence potentials', async () => {
  const ctx = fakeContext({
    lcu: {
      get: async (path) => {
        if (path === '/lol-loot/v1/player-loot') {
          return {
            status: 200,
            body: JSON.stringify([
              { lootId: 'CHAMPION_RENTAL_103', itemDesc: 'Ahri Shard', count: 2, value: 960, type: 'CHAMPION_RENTAL', disenchantValue: 960 }
            ])
          };
        }
        return { status: 404, body: '[]' };
      }
    }
  });

  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerLootTools(server, ctx);
  const tool = server._registeredTools['lol_analytics_loot_summary'];
  assert.ok(tool);

  const res = await tool.handler({});
  assert.equal(res.isError, undefined);
  const data = JSON.parse(res.content[0].text);
  assert.equal(data.totalChampionShards, 2);
  assert.equal(data.totalPotentialBlueEssence, 1920);
});

test('lol_workflow_loot_disenchant: crafts disenchant recipe', async () => {
  let disenchantedPath = null;
  const ctx = fakeContext({
    config: {
      writeAllowlist: ['POST /lol-loot/v1/recipes/*/craft']
    },
    lcu: {
      request: async (method, path) => {
        if (method === 'POST' && path.includes('_disenchant/craft')) {
          disenchantedPath = path;
          return { status: 200, body: '{}' };
        }
        return { status: 400, body: '' };
      }
    }
  });

  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerLootTools(server, ctx);
  const tool = server._registeredTools['lol_workflow_loot_disenchant'];
  assert.ok(tool);

  const res = await tool.handler({ lootId: 'CHAMPION_RENTAL_103', count: 1 });
  assert.equal(res.isError, undefined);
  assert.equal(disenchantedPath, '/lol-loot/v1/recipes/CHAMPION_RENTAL_103_disenchant/craft');
});
