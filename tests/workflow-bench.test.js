import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fakeContext } from './helpers/context.js';
import { registerWorkflowBenchTool } from '../src/tools/workflow_bench.js';

test('lol_workflow_champ_select_bench: swaps champion from ARAM bench', async () => {
  let swappedPath = null;
  const ctx = fakeContext({
    config: {
      writeAllowlist: ['POST /lol-champ-select/v1/session/bench/swap/*']
    },
    lcu: {
      get: async (path) => {
        if (path === '/lol-champ-select/v1/session') {
          return { status: 200, body: JSON.stringify({ benchChampions: [{ championId: 103 }] }) };
        }
        return { status: 404, body: '{}' };
      },
      request: async (method, path) => {
        if (method === 'POST' && path === '/lol-champ-select/v1/session/bench/swap/103') {
          swappedPath = path;
          return { status: 204, body: '' };
        }
        return { status: 400, body: '' };
      }
    },
    staticData: {
      load: async () => [{ id: 103, name: 'Ahri' }]
    }
  });

  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerWorkflowBenchTool(server, ctx);
  const tool = server._registeredTools['lol_workflow_champ_select_bench'];
  assert.ok(tool);

  const res = await tool.handler({ champion: 'Ahri' });
  assert.equal(res.isError, undefined);
  assert.equal(swappedPath, '/lol-champ-select/v1/session/bench/swap/103');
});
