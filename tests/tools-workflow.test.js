import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerWorkflowTools } from '../src/tools/workflow.js';
import { createServer } from '../src/index.js';
import { fakeContext } from './helpers/context.js';

// The macros mutate the client, so every write they send is checked against the
// same allowlist lol_request uses. Tests get the lines the shipped config carries
// unless they pass their own config to exercise a refusal.
const allowlistConfig = {
  writeAllowlist: [
    'POST /lol-matchmaking/v1/ready-check/accept',
    'POST /lol-lobby/v2/lobby',
    'DELETE /lol-lobby/v2/lobby',
    'POST /lol-lobby/v2/lobby/matchmaking/search',
    'PATCH /lol-champ-select/v1/session/actions/*',
    'POST /lol-perks/v1/pages',
    'PUT /lol-perks/v1/pages/*'
  ],
  configPath: 'config/allowlist.json'
};

async function connect(ctx) {
  const server = new McpServer({ name: 'test-workflow', version: '1.0.0' });
  registerWorkflowTools(server, { config: allowlistConfig, ...ctx });
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

  // A lock-in cannot be undone, a rune page overwrite destroys the old one, and
  // creating a lobby replaces whatever lobby is open — none of that is a
  // non-destructive, repeatable call.
  const expectedAnnotations = {
    lol_workflow_matchmaking_accept: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    lol_workflow_champ_select: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    lol_workflow_runes_set: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    lol_workflow_lobby: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  };

  for (const tool of workflowTools) {
    assert.deepEqual(tool.annotations, expectedAnnotations[tool.name], tool.name);
  }

  const acceptTool = workflowTools.find((t) => t.name === 'lol_workflow_matchmaking_accept');
  assert.equal(acceptTool.title, 'Accept matchmaking ready check');
  assert.match(acceptTool.description, /accepts if match is found/);
  assert.match(acceptTool.description, /write allowlist/);

  const champSelectTool = workflowTools.find((t) => t.name === 'lol_workflow_champ_select');
  assert.equal(champSelectTool.title, 'Pick, hover, or ban champion in champion select');
  assert.match(champSelectTool.description, /chooses champion by name or ID, and hovers or locks in/);
  assert.match(champSelectTool.description, /write allowlist/);

  const runesTool = workflowTools.find((t) => t.name === 'lol_workflow_runes_set');
  assert.equal(runesTool.title, 'Set or update active rune/perk page');
  assert.match(runesTool.description, /perk IDs and sets it active/);
  assert.match(runesTool.description, /only when its name matches/);
  assert.match(runesTool.description, /write allowlist/);

  const lobbyTool = workflowTools.find((t) => t.name === 'lol_workflow_lobby');
  assert.equal(lobbyTool.title, 'Create game lobby and optionally start matchmaking');
  assert.match(lobbyTool.description, /optionally starts matchmaking queue search/);
  assert.match(lobbyTool.description, /write allowlist/);

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
              { id: 42, isEditable: true, current: true, name: 'Antigravity Runes' }
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

test('lol_workflow_lobby refuses a write that is not on the allowlist', async () => {
  let sent = false;
  const ctx = {
    config: { writeAllowlist: ['POST /lol-matchmaking/v1/ready-check/accept'], configPath: 'config/allowlist.json' },
    lcu: {
      get: async () => ({ status: 404 }),
      request: async () => {
        sent = true;
        return { status: 200 };
      }
    }
  };

  const { client } = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_workflow_lobby',
    arguments: { queueId: 420 }
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /POST \/lol-lobby\/v2\/lobby/);
  assert.match(result.content[0].text, /writeAllowlist/);
  assert.equal(sent, false, 'A refused write must never reach the client');

  await client.close();
});

test('lol_workflow_champ_select refuses an ambiguous partial champion name', async () => {
  const ctx = {
    lcu: {
      get: async () => ({ status: 200, body: { localPlayerCellId: 1, actions: [] } }),
      request: async () => ({ status: 204 })
    },
    staticData: {
      load: async () => [
        { id: 10, name: 'Kayle' },
        { id: 145, name: "Kai'Sa" }
      ]
    }
  };

  const { client } = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_workflow_champ_select',
    arguments: { champion: 'Ka' }
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /ambiguous/i);
  assert.match(result.content[0].text, /Kayle/);
  assert.match(result.content[0].text, /Kai'Sa/);

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
