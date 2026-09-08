import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LcuSchemaService } from '../src/lcu/schema.js';

function createMockSwagger() {
  return {
    swagger: '2.0',
    info: { title: 'LeagueClient', version: '1.0.0' },
    paths: {
      '/lol-champ-select/v1/session': {
        get: {
          summary: 'Get champ select session',
          operationId: 'GetSession',
          responses: {
            '200': {
              description: 'Successful session response',
              schema: { $ref: '#/definitions/LolChampSelectSession' }
            }
          }
        },
        delete: {
          summary: 'Quit champ select session',
          operationId: 'QuitSession',
          responses: {
            '204': { description: 'Session ended' }
          }
        }
      },
      '/lol-champ-select/v1/current-champion': {
        get: {
          summary: 'Get current champion',
          operationId: 'GetCurrentChampion',
          responses: {
            '200': { description: 'Champion ID' }
          }
        }
      },
      '/lol-lobby/v2/lobby': {
        get: {
          summary: 'Get lobby',
          operationId: 'GetLobby',
          responses: {
            '200': {
              description: 'Lobby object',
              schema: { $ref: '#/definitions/LolLobby' }
            }
          }
        },
        post: {
          summary: 'Create lobby',
          operationId: 'CreateLobby',
          parameters: [
            {
              name: 'body',
              in: 'body',
              schema: { $ref: '#/definitions/CreateLobbyDto' }
            }
          ],
          responses: {
            '200': {
              description: 'Created lobby',
              schema: { $ref: '#/definitions/LolLobby' }
            }
          }
        }
      }
    },
    definitions: {
      LolChampSelectSession: {
        type: 'object',
        properties: {
          chatDetails: { $ref: '#/definitions/ChatDetails' },
          hasSimultaneousBans: { type: 'boolean' }
        }
      },
      ChatDetails: {
        type: 'object',
        properties: {
          chatRoomName: { type: 'string' }
        }
      },
      LolLobby: {
        type: 'object',
        properties: {
          partyId: { type: 'string' },
          members: {
            type: 'array',
            items: { $ref: '#/definitions/LobbyMember' }
          }
        }
      },
      LobbyMember: {
        type: 'object',
        properties: {
          summonerId: { type: 'number' }
        }
      },
      CreateLobbyDto: {
        type: 'object',
        properties: {
          queueId: { type: 'number' }
        }
      },
      SelfRefNode: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          child: { $ref: '#/definitions/SelfRefNode' }
        }
      },
      CircularA: {
        type: 'object',
        properties: {
          b: { $ref: '#/definitions/CircularB' }
        }
      },
      CircularB: {
        type: 'object',
        properties: {
          a: { $ref: '#/definitions/CircularA' }
        }
      }
    }
  };
}

function createMockClient(customDoc = createMockSwagger()) {
  let callCount = 0;
  const client = {
    getCallCount: () => callCount,
    get: async (path) => {
      callCount++;
      if (path === '/swagger/v2/swagger.json') {
        return { status: 200, body: customDoc };
      }
      return { status: 404, body: 'Not found' };
    }
  };
  return client;
}

test('fetches and caches swagger document', async () => {
  const mockDoc = createMockSwagger();
  const client = createMockClient(mockDoc);
  const service = new LcuSchemaService({ client });

  const firstFetch = await service.fetchSchema();
  assert.deepEqual(firstFetch, mockDoc);
  assert.equal(client.getCallCount(), 1);

  // Second fetch without refresh must hit in-memory cache
  const secondFetch = await service.fetchSchema();
  assert.deepEqual(secondFetch, mockDoc);
  assert.equal(client.getCallCount(), 1, 'should not call client.get when cached');
});

test('refresh: true re-fetches schema from client', async () => {
  const initialDoc = createMockSwagger();
  const updatedDoc = { ...createMockSwagger(), info: { title: 'LeagueClientUpdated', version: '2.0.0' } };
  let calls = 0;
  const client = {
    get: async () => {
      calls++;
      return { status: 200, body: calls === 1 ? initialDoc : updatedDoc };
    }
  };
  const service = new LcuSchemaService({ client });

  const firstFetch = await service.fetchSchema();
  assert.equal(firstFetch.info.version, '1.0.0');
  assert.equal(calls, 1);

  const refreshedFetch = await service.fetchSchema({ refresh: true });
  assert.equal(refreshedFetch.info.version, '2.0.0');
  assert.equal(calls, 2);
});

test('querying by exact path returns matching operations', async () => {
  const client = createMockClient();
  const service = new LcuSchemaService({ client });

  const result = await service.query({ path: '/lol-champ-select/v1/session' });
  assert.ok(result.paths);
  const paths = Object.keys(result.paths);
  assert.equal(paths.length, 1);
  assert.equal(paths[0], '/lol-champ-select/v1/session');
  assert.ok(result.paths['/lol-champ-select/v1/session'].get);
  assert.ok(result.paths['/lol-champ-select/v1/session'].delete);
  assert.equal(result.paths['/lol-champ-select/v1/session'].get.operationId, 'GetSession');
});

test('querying by partial path performs case-insensitive substring search', async () => {
  const client = createMockClient();
  const service = new LcuSchemaService({ client });

  const result = await service.query({ path: 'champ-select' });
  assert.ok(result.paths);
  const paths = Object.keys(result.paths);
  assert.equal(paths.length, 2);
  assert.ok(paths.includes('/lol-champ-select/v1/session'));
  assert.ok(paths.includes('/lol-champ-select/v1/current-champion'));

  // Case-insensitivity test
  const uppercaseResult = await service.query({ path: 'CHAMP-SELECT' });
  assert.deepEqual(Object.keys(uppercaseResult.paths), paths);
});

test('querying path with no matches returns empty paths object', async () => {
  const client = createMockClient();
  const service = new LcuSchemaService({ client });

  const result = await service.query({ path: 'unknown-path' });
  assert.ok(result.paths);
  assert.equal(Object.keys(result.paths).length, 0);
});

test('filtering by HTTP method isolates specific verb', async () => {
  const client = createMockClient();
  const service = new LcuSchemaService({ client });

  // Filter GET
  const getResult = await service.query({ path: '/lol-lobby/v2/lobby', method: 'GET' });
  assert.ok(getResult.paths['/lol-lobby/v2/lobby'].get);
  assert.equal(getResult.paths['/lol-lobby/v2/lobby'].post, undefined);

  // Filter POST (case-insensitive verb)
  const postResult = await service.query({ path: '/lol-lobby/v2/lobby', method: 'post' });
  assert.ok(postResult.paths['/lol-lobby/v2/lobby'].post);
  assert.equal(postResult.paths['/lol-lobby/v2/lobby'].get, undefined);

  // Method not present on path
  const deleteResult = await service.query({ path: '/lol-lobby/v2/lobby', method: 'DELETE' });
  assert.equal(Object.keys(deleteResult.paths).length, 0);
});

test('querying by model name returns dereferenced model schema', async () => {
  const client = createMockClient();
  const service = new LcuSchemaService({ client });

  const result = await service.query({ model: 'LolChampSelectSession' });
  assert.equal(result.model, 'LolChampSelectSession');
  assert.ok(result.schema);
  assert.equal(result.schema.type, 'object');
  // Nested $ref chatDetails should be dereferenced
  assert.ok(result.schema.properties.chatDetails);
  assert.equal(result.schema.properties.chatDetails.properties.chatRoomName.type, 'string');

  // Case-insensitive model lookup
  const caseInsensitiveResult = await service.query({ model: 'lolchampselectsession' });
  assert.equal(caseInsensitiveResult.model, 'LolChampSelectSession');
  assert.ok(caseInsensitiveResult.schema);

  // Non-existent model lookup
  const unknownResult = await service.query({ model: 'UnknownModel' });
  assert.equal(unknownResult.model, 'UnknownModel');
  assert.equal(unknownResult.schema, null);
});

test('dereference expands $ref pointers in parameters and responses', async () => {
  const client = createMockClient();
  const service = new LcuSchemaService({ client });

  const result = await service.query({ path: '/lol-lobby/v2/lobby', method: 'POST' });
  const postOp = result.paths['/lol-lobby/v2/lobby'].post;

  // Parameter schema expanded
  const bodyParam = postOp.parameters.find((p) => p.name === 'body');
  assert.ok(bodyParam.schema.properties.queueId);
  assert.equal(bodyParam.schema.properties.queueId.type, 'number');

  // Response schema expanded
  const res200 = postOp.responses['200'];
  assert.ok(res200.schema.properties.partyId);
  assert.ok(res200.schema.properties.members.items.properties.summonerId);
});

test('dereference handles circular references safely without infinite recursion', async () => {
  const client = createMockClient();
  const service = new LcuSchemaService({ client });

  // Self-referencing model
  const selfRefResult = await service.query({ model: 'SelfRefNode' });
  assert.equal(selfRefResult.model, 'SelfRefNode');
  assert.ok(selfRefResult.schema.properties.child);
  // It should expand up to max depth ~3 and stop safely
  assert.ok(selfRefResult.schema.properties.child.properties.child);

  // Mutual circular references (A <-> B)
  const circularResult = await service.query({ model: 'CircularA' });
  assert.equal(circularResult.model, 'CircularA');
  assert.ok(circularResult.schema.properties.b);
  assert.ok(circularResult.schema.properties.b.properties.a);
});

test('summary view returned when called without path or model', async () => {
  const client = createMockClient();
  const service = new LcuSchemaService({ client });

  const result = await service.query();
  assert.deepEqual(result.info, { title: 'LeagueClient', version: '1.0.0' });
  assert.equal(result.pathsCount, 3);
  assert.equal(result.definitionsCount, 8);
  assert.deepEqual(result.paths, [
    '/lol-champ-select/v1/session',
    '/lol-champ-select/v1/current-champion',
    '/lol-lobby/v2/lobby'
  ]);

  // Calling with empty object produces same summary
  const emptyObjResult = await service.query({});
  assert.equal(emptyObjResult.pathsCount, 3);
});

test('fetchSchema parses stringified JSON responses', async () => {
  const mockDoc = createMockSwagger();
  const client = {
    get: async () => ({ status: 200, body: JSON.stringify(mockDoc) })
  };
  const service = new LcuSchemaService({ client });

  const doc = await service.fetchSchema();
  assert.deepEqual(doc, mockDoc);
});

test('fetchSchema throws on HTTP error or missing client', async () => {
  const failingClient = {
    get: async () => ({ status: 500, body: 'Server Error' })
  };
  const service = new LcuSchemaService({ client: failingClient });
  await assert.rejects(() => service.fetchSchema(), /HTTP 500/);

  const missingClientService = new LcuSchemaService({});
  await assert.rejects(() => missingClientService.fetchSchema(), /LCU client is required/);
});
