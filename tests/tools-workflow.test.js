import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerWorkflowTools } from '../src/tools/workflow.js';
import { createServer } from '../src/index.js';
import { fakeContext } from './helpers/context.js';

async function connect(ctx) {
  const server = new McpServer({ name: 'test-workflow', version: '1.0.0' });
  registerWorkflowTools(server, ctx);
  const client = new Client({ name: 'test', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);
  return { client, server };
}

test('registers all 4 workflow tools with proper annotations, titles, and descriptions', async () => {
  const { client } = await connect(fakeContext());
  const { tools } = await client.listTools();
  const workflowTools = tools.filter((t) => t.name.startsWith('lol_workflow_'));
  const names = workflowTools.map((t) => t.name).sort();

  assert.deepEqual(names, [
    'lol_workflow_champ_select',
    'lol_workflow_lobby',
    'lol_workflow_matchmaking_accept',
    'lol_workflow_runes_set'
  ]);

  for (const tool of workflowTools) {
    assert.deepEqual(tool.annotations, {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    });
  }

  const acceptTool = workflowTools.find((t) => t.name === 'lol_workflow_matchmaking_accept');
  assert.equal(acceptTool.title, 'Accept matchmaking ready check');
  assert.equal(acceptTool.description, 'Checks matchmaking ready check status and accepts if match is found.');

  const champSelectTool = workflowTools.find((t) => t.name === 'lol_workflow_champ_select');
  assert.equal(champSelectTool.title, 'Pick, hover, or ban champion in champion select');
  assert.equal(
    champSelectTool.description,
    'Resolves local player action in active champion select, chooses champion by name or ID, and hovers or locks in.'
  );

  const runesTool = workflowTools.find((t) => t.name === 'lol_workflow_runes_set');
  assert.equal(runesTool.title, 'Set or update active rune/perk page');
  assert.equal(
    runesTool.description,
    'Creates or updates an editable rune page with specified primary/sub styles and perk IDs and sets it active.'
  );

  const lobbyTool = workflowTools.find((t) => t.name === 'lol_workflow_lobby');
  assert.equal(lobbyTool.title, 'Create game lobby and optionally start matchmaking');
  assert.equal(
    lobbyTool.description,
    'Creates a custom or matchmade lobby for a queue (e.g. 420 for Ranked Solo, 450 for ARAM) and optionally starts matchmaking queue search.'
  );

  await client.close();
});

test('lol_workflow_matchmaking_accept accepts ready check', async () => {
  let postCalled = false;
  const ctx = {
    lcu: {
      get: async (url) => {
        if (url === '/lol-matchmaking/v1/ready-check') {
          return { status: 200, body: { state: 'InProgress', playerResponse: 'None' } };
        }
        return { status: 404 };
      },
      request: async (method, url) => {
        if (method === 'POST' && url === '/lol-matchmaking/v1/ready-check/accept') {
          postCalled = true;
          return { status: 204 };
        }
        return { status: 404 };
      }
    }
  };

  const { client } = await connect(ctx);
  const result = await client.callTool({ name: 'lol_workflow_matchmaking_accept', arguments: {} });
  assert.equal(result.isError, undefined);
  assert.equal(postCalled, true);

  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.success, true);
  assert.equal(payload.state, 'InProgress');
  assert.equal(payload.playerResponse, 'Accepted');
  assert.equal(payload.message, 'Matchmaking ready check accepted');

  await client.close();
});

test('lol_workflow_matchmaking_accept handles errors via guard', async () => {
  const ctx = {
    lcu: {
      get: async () => ({ status: 200, body: { state: 'InProgress', playerResponse: 'None' } }),
      request: async () => ({ status: 500, body: { error: 'Internal Server Error' } })
    }
  };

  const { client } = await connect(ctx);
  const result = await client.callTool({ name: 'lol_workflow_matchmaking_accept', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Failed to accept ready check: HTTP 500/);

  await client.close();
});

test('lol_workflow_champ_select picks champion with defaults', async () => {
  let patched = null;
  const ctx = {
    lcu: {
      get: async (url) => {
        if (url === '/lol-champ-select/v1/session') {
          return {
            status: 200,
            body: {
              localPlayerCellId: 1,
              actions: [
                [
                  { id: 10, actorCellId: 1, type: 'pick', completed: false, isInProgress: true },
                  { id: 11, actorCellId: 2, type: 'pick', completed: false, isInProgress: true }
                ]
              ]
            }
          };
        }
        return { status: 404 };
      },
      request: async (method, url, body) => {
        if (method === 'PATCH' && url === '/lol-champ-select/v1/session/actions/10') {
          patched = body;
          return { status: 204 };
        }
        return { status: 404 };
      }
    },
    staticData: {
      load: async (kind) => {
        if (kind === 'champions') {
          return [
            { id: 266, name: 'Aatrox' },
            { id: 157, name: 'Yasuo' }
          ];
        }
        return [];
      }
    }
  };

  const { client } = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_workflow_champ_select',
    arguments: { champion: 'Aatrox' }
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(patched, { championId: 266, completed: true });

  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.success, true);
  assert.equal(payload.inChampSelect, true);
  assert.equal(payload.actionId, 10);
  assert.equal(payload.type, 'pick');
  assert.equal(payload.championId, 266);
  assert.equal(payload.championName, 'Aatrox');
  assert.equal(payload.completed, true);
  assert.equal(payload.message, 'Locked in Aatrox');

  await client.close();
});

test('lol_workflow_champ_select bans champion with numeric ID and hover', async () => {
  let patched = null;
  const ctx = {
    lcu: {
      get: async (url) => {
        if (url === '/lol-champ-select/v1/session') {
          return {
            status: 200,
            body: {
              localPlayerCellId: 1,
              actions: [
                [
                  { id: 10, actorCellId: 1, type: 'ban', completed: false, isInProgress: true }
                ]
              ]
            }
          };
        }
        return { status: 404 };
      },
      request: async (method, url, body) => {
        if (method === 'PATCH' && url === '/lol-champ-select/v1/session/actions/10') {
          patched = body;
          return { status: 204 };
        }
        return { status: 404 };
      }
    },
    staticData: {
      load: async () => []
    }
  };

  const { client } = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_workflow_champ_select',
    arguments: { champion: 157, type: 'ban', completed: false }
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(patched, { championId: 157, completed: false });

  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.success, true);
  assert.equal(payload.inChampSelect, true);
  assert.equal(payload.actionId, 10);
  assert.equal(payload.type, 'ban');
  assert.equal(payload.championId, 157);
  assert.equal(payload.completed, false);
  assert.equal(payload.message, 'Hovered 157');

  await client.close();
});

test('lol_workflow_champ_select handles not in champ select', async () => {
  const ctx = {
    lcu: {
      get: async () => ({ status: 404 })
    },
    staticData: {
      load: async () => []
    }
  };

  const { client } = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_workflow_champ_select',
    arguments: { champion: 266 }
  });

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.success, false);
  assert.equal(payload.inChampSelect, false);
  assert.equal(payload.message, 'Not currently in champion select');

  await client.close();
});

test('lol_workflow_champ_select returns error via guard when champion is unknown', async () => {
  const ctx = {
    lcu: {
      get: async () => ({ status: 200, body: { localPlayerCellId: 1, actions: [] } })
    },
    staticData: {
      load: async () => []
    }
  };

  const { client } = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_workflow_champ_select',
    arguments: { champion: 'NonExistentChampion' }
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Champion not found: NonExistentChampion/);

  await client.close();
});

test('lol_workflow_runes_set updates existing editable page with defaults', async () => {
  let putBody = null;
  const ctx = {
    lcu: {
      get: async (url) => {
        if (url === '/lol-perks/v1/pages') {
          return {
            status: 200,
            body: [
              { id: 42, isEditable: true, current: true, name: 'Old Page' }
            ]
          };
        }
        return { status: 404 };
      },
      request: async (method, url, body) => {
        if (method === 'PUT' && url === '/lol-perks/v1/pages/42') {
          putBody = body;
          return { status: 204 };
        }
        return { status: 404 };
      }
    }
  };

  const { client } = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_workflow_runes_set',
    arguments: {
      primaryStyleId: 8000,
      subStyleId: 8100,
      selectedPerkIds: [8005, 8008, 8014, 8017, 8126, 8139]
    }
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(putBody, {
    name: 'Antigravity Runes',
    primaryStyleId: 8000,
    subStyleId: 8100,
    selectedPerkIds: [8005, 8008, 8014, 8017, 8126, 8139],
    current: true
  });

  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.success, true);
  assert.equal(payload.pageId, 42);
  assert.equal(payload.name, 'Antigravity Runes');
  assert.equal(payload.primaryStyleId, 8000);
  assert.equal(payload.subStyleId, 8100);
  assert.deepEqual(payload.selectedPerkIds, [8005, 8008, 8014, 8017, 8126, 8139]);
  assert.equal(payload.message, 'Rune page active');

  await client.close();
});

test('lol_workflow_runes_set creates new page when replace is false', async () => {
  let postBody = null;
  const ctx = {
    lcu: {
      get: async () => ({
        status: 200,
        body: [{ id: 42, isEditable: true, current: true, name: 'Old Page' }]
      }),
      request: async (method, url, body) => {
        if (method === 'POST' && url === '/lol-perks/v1/pages') {
          postBody = body;
          return { status: 201, body: { id: 99 } };
        }
        return { status: 404 };
      }
    }
  };

  const { client } = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_workflow_runes_set',
    arguments: {
      name: 'Custom Page',
      primaryStyleId: 8000,
      subStyleId: 8100,
      selectedPerkIds: [8005],
      replace: false
    }
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(postBody, {
    name: 'Custom Page',
    primaryStyleId: 8000,
    subStyleId: 8100,
    selectedPerkIds: [8005],
    isEditable: true,
    current: true
  });

  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.success, true);
  assert.equal(payload.pageId, 99);
  assert.equal(payload.name, 'Custom Page');

  await client.close();
});

test('lol_workflow_runes_set returns error via guard when LCU fails', async () => {
  const ctx = {
    lcu: {
      get: async () => ({ status: 500 })
    }
  };

  const { client } = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_workflow_runes_set',
    arguments: {
      primaryStyleId: 8000,
      subStyleId: 8100,
      selectedPerkIds: [8005]
    }
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Failed to fetch rune pages/);

  await client.close();
});

test('lol_workflow_lobby creates lobby with default startMatchmaking=false', async () => {
  let created = null;
  const ctx = {
    lcu: {
      get: async () => ({ status: 404 }),
      request: async (method, url, body) => {
        if (method === 'POST' && url === '/lol-lobby/v2/lobby') {
          created = body;
          return { status: 200 };
        }
        return { status: 404 };
      }
    }
  };

  const { client } = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_workflow_lobby',
    arguments: { queueId: 420 }
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(created, { queueId: 420 });

  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.success, true);
  assert.equal(payload.queueId, 420);
  assert.equal(payload.matchmakingStarted, false);
  assert.equal(payload.message, 'Lobby created');

  await client.close();
});

test('lol_workflow_lobby creates lobby and starts matchmaking', async () => {
  let searchStarted = false;
  const ctx = {
    lcu: {
      get: async () => ({ status: 404 }),
      request: async (method, url) => {
        if (method === 'POST' && url === '/lol-lobby/v2/lobby') {
          return { status: 200 };
        }
        if (method === 'POST' && url === '/lol-lobby/v2/lobby/matchmaking/search') {
          searchStarted = true;
          return { status: 204 };
        }
        return { status: 404 };
      }
    }
  };

  const { client } = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_workflow_lobby',
    arguments: { queueId: 450, startMatchmaking: true }
  });

  assert.equal(result.isError, undefined);
  assert.equal(searchStarted, true);

  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.success, true);
  assert.equal(payload.queueId, 450);
  assert.equal(payload.matchmakingStarted, true);

  await client.close();
});

test('lol_workflow_lobby returns error via guard when LCU fails', async () => {
  const ctx = {
    lcu: {
      get: async () => ({ status: 404 }),
      request: async () => ({ status: 500 })
    }
  };

  const { client } = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_workflow_lobby',
    arguments: { queueId: 420 }
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Failed to create lobby: HTTP 500/);

  await client.close();
});

test('createServer integrates all workflow tools', async () => {
  const server = createServer(fakeContext());
  const client = new Client({ name: 'test', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);

  assert.ok(names.includes('lol_workflow_matchmaking_accept'));
  assert.ok(names.includes('lol_workflow_champ_select'));
  assert.ok(names.includes('lol_workflow_runes_set'));
  assert.ok(names.includes('lol_workflow_lobby'));

  await client.close();
});
