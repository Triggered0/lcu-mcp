import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fakeContext } from './helpers/context.js';
import { registerChatTools } from '../src/tools/chat.js';

test('lol_chat_send: sends chat message into active conversation', async () => {
  let sentBody = null;
  const ctx = fakeContext({
    config: {
      writeAllowlist: ['POST /lol-chat/v1/conversations/*/messages']
    },
    lcu: {
      get: async (path) => {
        if (path === '/lol-chat/v1/conversations') {
          return { status: 200, body: JSON.stringify([{ id: 'conv-champ-select', type: 'championSelect' }]) };
        }
        return { status: 404, body: '[]' };
      },
      request: async (method, path, body) => {
        if (method === 'POST' && path === '/lol-chat/v1/conversations/conv-champ-select/messages') {
          sentBody = JSON.parse(body);
          return { status: 200, body: JSON.stringify({ id: 'msg-1' }) };
        }
        return { status: 400, body: '' };
      }
    }
  });

  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerChatTools(server, ctx);
  const tool = server._registeredTools['lol_chat_send'];
  assert.ok(tool);

  const res = await tool.handler({ message: 'I can play mid' });
  assert.equal(res.isError, undefined);
  assert.equal(sentBody.body, 'I can play mid');
});

test('lol_chat_status: updates chat availability and presence text', async () => {
  let updatedBody = null;
  const ctx = fakeContext({
    config: {
      writeAllowlist: ['PUT /lol-chat/v1/me']
    },
    lcu: {
      request: async (method, path, body) => {
        if (method === 'PUT' && path === '/lol-chat/v1/me') {
          updatedBody = JSON.parse(body);
          return { status: 200, body: '{}' };
        }
        return { status: 400, body: '' };
      }
    }
  });

  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerChatTools(server, ctx);
  const tool = server._registeredTools['lol_chat_status'];
  assert.ok(tool);

  const res = await tool.handler({ availability: 'away', statusMessage: 'BRB' });
  assert.equal(res.isError, undefined);
  assert.equal(updatedBody.availability, 'away');
  assert.equal(updatedBody.statusMessage, 'BRB');
});
