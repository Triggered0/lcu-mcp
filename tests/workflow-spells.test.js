import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fakeContext } from './helpers/context.js';
import { registerWorkflowSpellsTool } from '../src/tools/workflow_spells.js';

test('lol_workflow_spells_set: resolves spell names and mutates selection', async () => {
  let patchedBody = null;
  const ctx = fakeContext({
    config: {
      writeAllowlist: ['PATCH /lol-champ-select/v1/session/my-selection']
    },
    lcu: {
      get: async (path) => {
        if (path === '/lol-champ-select/v1/session') {
          return { status: 200, body: JSON.stringify({ myTeam: [{ cellId: 0 }] }) };
        }
        return { status: 404, body: '{}' };
      },
      request: async (method, path, body) => {
        if (method === 'PATCH' && path === '/lol-champ-select/v1/session/my-selection') {
          patchedBody = JSON.parse(body);
          return { status: 204, body: '' };
        }
        return { status: 400, body: '' };
      }
    },
    staticData: {
      load: async () => [
        { id: 4, name: 'Flash' },
        { id: 14, name: 'Ignite' }
      ]
    }
  });

  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerWorkflowSpellsTool(server, ctx);
  const tool = server._registeredTools['lol_workflow_spells_set'];
  assert.ok(tool);

  const res = await tool.handler({ spell1: 'flash', spell2: 'ignite' });
  assert.equal(res.isError, undefined);
  assert.equal(patchedBody.spell1Id, 4);
  assert.equal(patchedBody.spell2Id, 14);
});
