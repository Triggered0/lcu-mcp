import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerGameTools } from '../src/tools/game.js';
import { GameNotRunningError } from '../src/game/client.js';

async function connect(ctx) {
  const server = new McpServer({ name: 'test-game', version: '1.0.0' });
  registerGameTools(server, ctx);
  const client = new Client({ name: 'test', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);
  return { client, server };
}

const mockAllGameData = {
  gameData: {
    gameMode: 'CLASSIC',
    gameTime: 600.0,
    mapName: 'Map11',
    mapTerrain: 'Default'
  },
  activePlayer: {
    summonerName: 'Faker',
    championName: 'Ahri',
    level: 6,
    currentGold: 500,
    championStats: {
      currentHealth: 1000,
      maxHealth: 1000,
      resourceValue: 500,
      resourceMax: 500,
      attackDamage: 70,
      abilityPower: 50
    },
    scores: {
      kills: 1,
      deaths: 0,
      assists: 2,
      creepScore: 60
    }
  },
  allPlayers: [
    {
      summonerName: 'Faker',
      championName: 'Ahri',
      team: 'ORDER',
      level: 6,
      scores: { kills: 1, deaths: 0, assists: 2, creepScore: 60 },
      items: [{ displayName: 'Doran Ring', itemID: 1056 }]
    },
    {
      summonerName: 'Deft',
      championName: 'Ezreal',
      team: 'CHAOS',
      level: 6,
      scores: { kills: 0, deaths: 1, assists: 0, creepScore: 55 },
      items: [{ displayName: 'Doran Blade', itemID: 1055 }]
    }
  ],
  events: {
    Events: [
      { EventID: 1, EventName: 'GameStart', EventTime: 0.1 }
    ]
  }
};

test('registers all 4 live game tools with proper annotations', async () => {
  const ctx = {
    gameClient: {
      getAllGameData: async () => mockAllGameData,
      getGameStats: async () => ({ gameMode: 'CLASSIC', gameTime: 600 }),
      getActivePlayer: async () => mockAllGameData.activePlayer,
      getPlayerList: async () => mockAllGameData.allPlayers,
      getEvents: async () => mockAllGameData.events
    }
  };

  const { client } = await connect(ctx);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['lol_game_all', 'lol_game_events', 'lol_game_player', 'lol_game_stats']);

  for (const tool of tools) {
    assert.deepEqual(tool.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    });
  }

  await client.close();
});

test('lol_game_all returns compact summary by default', async () => {
  let called = false;
  const ctx = {
    gameClient: {
      getAllGameData: async () => {
        called = true;
        return mockAllGameData;
      }
    }
  };

  const { client } = await connect(ctx);
  const result = await client.callTool({ name: 'lol_game_all', arguments: {} });
  assert.equal(result.isError, undefined);
  assert.equal(called, true);

  const payload = JSON.parse(result.content[0].text);
  assert.ok(payload.game);
  assert.equal(payload.game.mode, 'CLASSIC');
  assert.equal(payload.game.timeMinutes, 10);
  assert.ok(payload.activePlayer);
  assert.equal(payload.activePlayer.summonerName, 'Faker');
  assert.equal(payload.activePlayer.kda, '1/0/2');
  assert.ok(payload.teams);
  assert.equal(payload.teams.ORDER.kills, 1);
  assert.equal(payload.teams.CHAOS.kills, 0);

  await client.close();
});

test('lol_game_all returns raw data when format is raw', async () => {
  const ctx = {
    gameClient: {
      getAllGameData: async () => mockAllGameData
    }
  };

  const { client } = await connect(ctx);
  const result = await client.callTool({ name: 'lol_game_all', arguments: { format: 'raw' } });
  assert.equal(result.isError, undefined);

  const payload = JSON.parse(result.content[0].text);
  assert.deepEqual(payload, mockAllGameData);

  await client.close();
});

test('lol_game_stats returns match clock and stats', async () => {
  const ctx = {
    gameClient: {
      getGameStats: async () => ({ gameMode: 'CLASSIC', gameTime: 650.5, mapName: 'Map11' })
    }
  };

  const { client } = await connect(ctx);
  const result = await client.callTool({ name: 'lol_game_stats', arguments: {} });
  assert.equal(result.isError, undefined);

  const payload = JSON.parse(result.content[0].text);
  assert.deepEqual(payload, { gameMode: 'CLASSIC', gameTime: 650.5, mapName: 'Map11' });

  await client.close();
});

test('lol_game_player returns active player when name is omitted', async () => {
  let activeCalled = false;
  const ctx = {
    gameClient: {
      getActivePlayer: async () => {
        activeCalled = true;
        return { summonerName: 'Faker', championName: 'Ahri', level: 6 };
      },
      getPlayerList: async () => []
    }
  };

  const { client } = await connect(ctx);
  const result = await client.callTool({ name: 'lol_game_player', arguments: {} });
  assert.equal(result.isError, undefined);
  assert.equal(activeCalled, true);

  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.summonerName, 'Faker');
  assert.equal(payload.championName, 'Ahri');

  await client.close();
});

test('lol_game_player returns specific player when name is provided', async () => {
  let listCalled = false;
  const ctx = {
    gameClient: {
      getActivePlayer: async () => ({ summonerName: 'Faker' }),
      getPlayerList: async () => {
        listCalled = true;
        return [
          { summonerName: 'Faker', championName: 'Ahri', level: 6 },
          { summonerName: 'Deft', championName: 'Ezreal', level: 6 }
        ];
      }
    }
  };

  const { client } = await connect(ctx);
  const result = await client.callTool({ name: 'lol_game_player', arguments: { name: 'deft' } });
  assert.equal(result.isError, undefined);
  assert.equal(listCalled, true);

  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.summonerName, 'Deft');
  assert.equal(payload.championName, 'Ezreal');

  // Test riotIdGameName resolution
  const resRiotId = await client.callTool({ name: 'lol_game_player', arguments: { name: 'faker' } });
  assert.equal(resRiotId.isError, undefined);

  // Whitespace name falls back to active player
  const resWhitespace = await client.callTool({ name: 'lol_game_player', arguments: { name: '   ' } });
  assert.equal(resWhitespace.isError, undefined);
  const activePayload = JSON.parse(resWhitespace.content[0].text);
  assert.equal(activePayload.summonerName, 'Faker');

  await client.close();
});

test('lol_game_player returns error when specific player name is not found', async () => {
  const ctx = {
    gameClient: {
      getActivePlayer: async () => ({ summonerName: 'Faker' }),
      getPlayerList: async () => [
        { summonerName: 'Faker', championName: 'Ahri', level: 6 }
      ]
    }
  };

  const { client } = await connect(ctx);
  const result = await client.callTool({ name: 'lol_game_player', arguments: { name: 'UnknownPlayer' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Player "UnknownPlayer" not found/);

  await client.close();
});

test('lol_game_events forwards afterId parameter', async () => {
  let receivedAfterId = null;
  const ctx = {
    gameClient: {
      getEvents: async (afterId) => {
        receivedAfterId = afterId;
        return { Events: [{ EventID: 5, EventName: 'ChampionKill' }] };
      }
    }
  };

  const { client } = await connect(ctx);
  // Without afterId
  const res1 = await client.callTool({ name: 'lol_game_events', arguments: {} });
  assert.equal(res1.isError, undefined);
  assert.equal(receivedAfterId, undefined);

  // With afterId
  const res2 = await client.callTool({ name: 'lol_game_events', arguments: { afterId: 4 } });
  assert.equal(res2.isError, undefined);
  assert.equal(receivedAfterId, 4);

  const payload = JSON.parse(res2.content[0].text);
  assert.deepEqual(payload.Events, [{ EventID: 5, EventName: 'ChampionKill' }]);

  await client.close();
});

test('GameNotRunningError returns clean MCP error message without stack trace', async () => {
  const ctx = {
    gameClient: {
      getAllGameData: async () => {
        throw new GameNotRunningError();
      },
      getGameStats: async () => {
        throw new GameNotRunningError();
      },
      getActivePlayer: async () => {
        throw new GameNotRunningError();
      },
      getEvents: async () => {
        throw new GameNotRunningError();
      }
    }
  };

  const { client } = await connect(ctx);

  for (const name of ['lol_game_all', 'lol_game_stats', 'lol_game_player', 'lol_game_events']) {
    const result = await client.callTool({ name, arguments: {} });
    assert.equal(result.isError, true, `${name} should report isError: true`);
    assert.equal(
      result.content[0].text,
      'Live game is not currently running. The Live Client Data API is only active during matches.'
    );
    assert.ok(
      !result.content[0].text.includes('at '),
      `${name} error text should not contain stack trace`
    );
  }

  await client.close();
});
