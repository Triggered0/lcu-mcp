import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSchemaTools } from '../src/tools/schema.js';
import { createServer } from '../src/index.js';
import { LcuSchemaService } from '../src/lcu/schema.js';
import { fakeContext } from './helpers/context.js';

async function connect(ctx) {
  const server = new McpServer({ name: 'test-schema', version: '1.0.0' });
  registerSchemaTools(server, ctx);
  const client = new Client({ name: 'test', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);
  return { client, server };
}

test('lol_schema registers tool with expected title and description', async () => {
  const ctx = fakeContext();
  const { client } = await connect(ctx);
  const tools = (await client.listTools()).tools;
  const tool = tools.find((t) => t.name === 'lol_schema');
  assert.ok(tool);
  assert.equal(tool.title, 'Query LCU OpenAPI/Swagger schema');
  assert.equal(
    tool.description,
    "Inspect internal LCU API endpoint signatures, parameters, request bodies, and models using the client's live OpenAPI/Swagger v2 specification."
  );
  await client.close();
});

test('lol_schema without arguments returns summary', async () => {
  let queryArgs = null;
  const ctx = fakeContext({
    schema: {
      query: async (args) => {
        queryArgs = args;
        return {
          info: { title: 'LeagueClient', version: '1.0.0' },
          pathsCount: 42,
          definitionsCount: 10,
          paths: ['/lol-gameflow/v1/gameflow-phase']
        };
      }
    }
  });

  const { client } = await connect(ctx);
  const result = await client.callTool({ name: 'lol_schema', arguments: {} });
  assert.equal(result.isError, undefined);

  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.pathsCount, 42);
  assert.equal(payload.definitionsCount, 10);
  assert.deepEqual(payload.paths, ['/lol-gameflow/v1/gameflow-phase']);
  assert.deepEqual(queryArgs, {
    path: undefined,
    method: undefined,
    model: undefined,
    refresh: false
  });

  await client.close();
});

test('lol_schema with path returns matching endpoint operations and parameters', async () => {
  let queryArgs = null;
  const ctx = fakeContext({
    schema: {
      query: async (args) => {
        queryArgs = args;
        return {
          paths: {
            '/lol-lobby/v2/lobby': {
              get: {
                summary: 'Get lobby',
                responses: { '200': { description: 'Success' } }
              }
            }
          }
        };
      }
    }
  });

  const { client } = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_schema',
    arguments: { path: '/lol-lobby/v2/lobby' }
  });
  assert.equal(result.isError, undefined);

  const payload = JSON.parse(result.content[0].text);
  assert.ok(payload.paths['/lol-lobby/v2/lobby']);
  assert.equal(payload.paths['/lol-lobby/v2/lobby'].get.summary, 'Get lobby');
  assert.equal(queryArgs.path, '/lol-lobby/v2/lobby');

  await client.close();
});

test('lol_schema with model returns dereferenced model schema', async () => {
  let queryArgs = null;
  const ctx = fakeContext({
    schema: {
      query: async (args) => {
        queryArgs = args;
        return {
          model: 'LolLobbyLobbyDto',
          schema: {
            type: 'object',
            properties: {
              partyId: { type: 'string' }
            }
          }
        };
      }
    }
  });

  const { client } = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_schema',
    arguments: { model: 'LolLobbyLobbyDto' }
  });
  assert.equal(result.isError, undefined);

  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.model, 'LolLobbyLobbyDto');
  assert.equal(payload.schema.properties.partyId.type, 'string');
  assert.equal(queryArgs.model, 'LolLobbyLobbyDto');

  await client.close();
});

test('lol_schema with refresh: true forwards refresh flag', async () => {
  let queryArgs = null;
  const ctx = fakeContext({
    schema: {
      query: async (args) => {
        queryArgs = args;
        return { pathsCount: 0, definitionsCount: 0, paths: [] };
      }
    }
  });

  const { client } = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_schema',
    arguments: { refresh: true }
  });
  assert.equal(result.isError, undefined);
  assert.equal(queryArgs.refresh, true);

  await client.close();
});

test('lol_schema with method forwards method filter', async () => {
  let queryArgs = null;
  const ctx = fakeContext({
    schema: {
      query: async (args) => {
        queryArgs = args;
        return {
          paths: {
            '/lol-lobby/v2/lobby': {
              post: { summary: 'Create lobby' }
            }
          }
        };
      }
    }
  });

  const { client } = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_schema',
    arguments: { path: 'lobby', method: 'POST' }
  });
  assert.equal(result.isError, undefined);
  assert.equal(queryArgs.method, 'POST');
  assert.equal(queryArgs.path, 'lobby');

  await client.close();
});

test('lol_schema rejects invalid HTTP method', async () => {
  const ctx = fakeContext();
  const { client } = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_schema',
    arguments: { method: 'INVALID' }
  });
  assert.equal(result.isError, true);
  await client.close();
});

test('lol_schema returns error via guard when schema query fails', async () => {
  const ctx = fakeContext({
    schema: {
      query: async () => {
        throw new Error('LCU request GET /swagger/v2/swagger.json failed: HTTP 503');
      }
    }
  });

  const { client } = await connect(ctx);
  const result = await client.callTool({ name: 'lol_schema', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /HTTP 503/);

  await client.close();
});

test('createServer integrates lol_schema', async () => {
  const ctx = fakeContext();
  const server = createServer(ctx);
  const client = new Client({ name: 'test', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);

  const tools = (await client.listTools()).tools;
  const schemaTool = tools.find((t) => t.name === 'lol_schema');
  assert.ok(schemaTool, 'lol_schema should be registered in createServer');
  assert.equal(schemaTool.title, 'Query LCU OpenAPI/Swagger schema');

  await client.close();
});

test('end-to-end integration with real LcuSchemaService', async () => {
  const fakeSwagger = {
    swagger: '2.0',
    info: { title: 'LeagueClient', version: '1.0.0' },
    paths: {
      '/lol-gameflow/v1/gameflow-phase': {
        get: {
          operationId: 'GetGameflowPhase',
          responses: {
            '200': {
              description: 'Phase',
              schema: { $ref: '#/definitions/LolGameflowGameflowPhase' }
            }
          }
        }
      }
    },
    definitions: {
      LolGameflowGameflowPhase: {
        type: 'string',
        description: 'Current phase'
      }
    }
  };

  const ctx = fakeContext({
    schema: new LcuSchemaService({
      client: {
        get: async () => ({ status: 200, body: fakeSwagger })
      }
    })
  });

  const { client } = await connect(ctx);
  const res = await client.callTool({
    name: 'lol_schema',
    arguments: { path: 'gameflow-phase' }
  });
  assert.equal(res.isError, undefined);

  const payload = JSON.parse(res.content[0].text);
  assert.ok(payload.paths['/lol-gameflow/v1/gameflow-phase']);
  assert.equal(
    payload.paths['/lol-gameflow/v1/gameflow-phase'].get.responses['200'].schema.type,
    'string'
  );

  await client.close();
});
