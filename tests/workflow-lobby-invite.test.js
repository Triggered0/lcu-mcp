import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fakeContext } from './helpers/context.js';
import { registerWorkflowLobbyInviteTool } from '../src/tools/workflow_lobby_invite.js';

test('lol_workflow_lobby_invite: sends invitations to PUUIDs', async () => {
  let invitePayload = null;
  const ctx = fakeContext({
    config: {
      writeAllowlist: ['POST /lol-lobby/v2/lobby/invitations']
    },
    lcu: {
      get: async (path) => {
        if (path === '/lol-lobby/v2/lobby') return { status: 200, body: '{}' };
        return { status: 404, body: '{}' };
      },
      request: async (method, path, body) => {
        if (method === 'POST' && path === '/lol-lobby/v2/lobby/invitations') {
          invitePayload = JSON.parse(body);
          return { status: 200, body: '[]' };
        }
        return { status: 400, body: '' };
      }
    }
  });

  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerWorkflowLobbyInviteTool(server, ctx);
  const tool = server._registeredTools['lol_workflow_lobby_invite'];
  assert.ok(tool);

  const res = await tool.handler({ toSummonerPuuids: ['puuid-target-1'] });
  assert.equal(res.isError, undefined);
  assert.equal(invitePayload[0].toSummonerPuuid, 'puuid-target-1');
});
