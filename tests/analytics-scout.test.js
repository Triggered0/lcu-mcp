import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fakeContext } from './helpers/context.js';
import { registerScoutAnalyticsTools } from '../src/tools/analytics_scout.js';

test('lol_analytics_champ_select_scout: identifies champ select status and draft mix', async () => {
  const ctx = fakeContext({
    lcu: {
      get: async (path) => {
        if (path === '/lol-champ-select/v1/session') {
          return {
            status: 200,
            body: JSON.stringify({
              myTeam: [
                { championId: 103, assignedPosition: 'middle', cellId: 0 },
                { championId: 81, assignedPosition: 'bottom', cellId: 1 }
              ]
            })
          };
        }
        return { status: 404, body: '{}' };
      }
    },
    staticData: {
      load: async () => [
        { id: 103, name: 'Ahri', roles: ['mage', 'assassin'] },
        { id: 81, name: 'Ezreal', roles: ['marksman', 'mage'] }
      ]
    }
  });

  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerScoutAnalyticsTools(server, ctx);
  const tool = server._registeredTools['lol_analytics_champ_select_scout'];
  assert.ok(tool);

  const res = await tool.handler({});
  assert.equal(res.isError, undefined);
  const data = JSON.parse(res.content[0].text);
  assert.equal(data.inChampSelect, true);
  assert.equal(data.teamSize, 2);
  assert.equal(data.draft[0].championName, 'Ahri');
});
