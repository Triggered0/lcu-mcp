import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeGameData } from '../src/game/summary.js';

test('summarizeGameData produces compact match overview from raw allgamedata', () => {
  const rawFixture = {
    gameData: {
      gameMode: 'CLASSIC',
      gameTime: 1254.5,
      mapName: 'Map11',
      mapNumber: 11,
      mapTerrain: 'Infernal'
    },
    activePlayer: {
      summonerName: 'Faker',
      championName: 'Ahri',
      level: 13,
      currentGold: 1450,
      championStats: {
        currentHealth: 1650,
        maxHealth: 1800,
        resourceValue: 800,
        resourceMax: 1100,
        attackDamage: 110,
        abilityPower: 250
      },
      scores: {
        kills: 5,
        deaths: 1,
        assists: 4,
        creepScore: 185
      }
    },
    allPlayers: [
      {
        summonerName: 'Faker',
        championName: 'Ahri',
        team: 'ORDER',
        level: 13,
        scores: { kills: 5, deaths: 1, assists: 4, creepScore: 185 },
        items: [{ displayName: "Luden's Companion", price: 3000 }]
      },
      {
        summonerName: 'Chovy',
        championName: 'Azir',
        team: 'CHAOS',
        level: 13,
        scores: { kills: 2, deaths: 3, assists: 2, creepScore: 190 },
        items: [{ displayName: "Nashor's Tooth", price: 3000 }]
      }
    ],
    events: {
      Events: [
        { EventID: 1, EventName: 'GameStart', EventTime: 0.1 },
        { EventID: 2, EventName: 'ChampionKill', EventTime: 180.2, KillerName: 'Faker', VictimName: 'Chovy' }
      ]
    }
  };

  const summary = summarizeGameData(rawFixture);
  assert.equal(summary.game.mode, 'CLASSIC');
  assert.equal(summary.game.gameTime, 1254.5);
  assert.equal(summary.game.timeMinutes, 20.9);
  assert.equal(summary.game.mapName, 'Map11');
  assert.equal(summary.game.mapTerrain, 'Infernal');

  assert.equal(summary.activePlayer.summonerName, 'Faker');
  assert.equal(summary.activePlayer.championName, 'Ahri');
  assert.equal(summary.activePlayer.level, 13);
  assert.equal(summary.activePlayer.currentGold, 1450);
  assert.equal(summary.activePlayer.health, '1650/1800');
  assert.equal(summary.activePlayer.resource, '800/1100');
  assert.equal(summary.activePlayer.attackDamage, 110);
  assert.equal(summary.activePlayer.abilityPower, 250);
  assert.equal(summary.activePlayer.kda, '5/1/4');
  assert.equal(summary.activePlayer.creepScore, 185);

  assert.equal(summary.teams.ORDER.kills, 5);
  assert.equal(summary.teams.ORDER.deaths, 1);
  assert.equal(summary.teams.ORDER.assists, 4);
  assert.equal(summary.teams.ORDER.players.length, 1);
  assert.deepEqual(summary.teams.ORDER.players[0], {
    summonerName: 'Faker',
    championName: 'Ahri',
    level: 13,
    kda: '5/1/4',
    creepScore: 185,
    items: ["Luden's Companion"]
  });

  assert.equal(summary.teams.CHAOS.kills, 2);
  assert.equal(summary.teams.CHAOS.deaths, 3);
  assert.equal(summary.teams.CHAOS.assists, 2);
  assert.equal(summary.teams.CHAOS.players.length, 1);

  assert.equal(summary.latestEvents.length, 2);
  assert.deepEqual(summary.latestEvents[1], {
    id: 2,
    name: 'ChampionKill',
    time: 180.2,
    killer: 'Faker',
    victim: 'Chovy'
  });
});

test('summarizeGameData gracefully handles empty or partial objects', () => {
  const summary = summarizeGameData({});
  assert.ok(summary.game);
  assert.equal(summary.game.mode, 'UNKNOWN');
  assert.equal(summary.game.gameTime, 0);
  assert.equal(summary.game.timeMinutes, 0);
  assert.equal(summary.game.mapName, 'UNKNOWN');
  assert.equal(summary.game.mapTerrain, 'Default');

  assert.ok(summary.activePlayer);
  assert.equal(summary.activePlayer.summonerName, 'Unknown');
  assert.equal(summary.activePlayer.championName, 'Unknown');
  assert.equal(summary.activePlayer.level, 1);
  assert.equal(summary.activePlayer.currentGold, 0);
  assert.equal(summary.activePlayer.health, '0/0');
  assert.equal(summary.activePlayer.resource, '0/0');
  assert.equal(summary.activePlayer.attackDamage, 0);
  assert.equal(summary.activePlayer.abilityPower, 0);
  assert.equal(summary.activePlayer.kda, '0/0/0');
  assert.equal(summary.activePlayer.creepScore, 0);

  assert.ok(summary.teams);
  assert.deepEqual(summary.teams.ORDER, { kills: 0, deaths: 0, assists: 0, players: [] });
  assert.deepEqual(summary.teams.CHAOS, { kills: 0, deaths: 0, assists: 0, players: [] });
  assert.deepEqual(summary.latestEvents, []);

  // Also test undefined argument
  const summaryUndefined = summarizeGameData();
  assert.ok(summaryUndefined.game);
  assert.ok(summaryUndefined.teams);
});

test('summarizeGameData handles team 200, riotId fallbacks, item naming fallbacks, and event slicing', () => {
  const rawFixture = {
    activePlayer: {
      riotId: 'HideOnBush#KR1',
      championName: 'Zed'
    },
    allPlayers: [
      {
        riotId: 'PlayerOne#NA1',
        championName: 'Garen',
        team: '100',
        items: [
          { name: 'DoranBlade' },
          { itemID: 1055 },
          {}
        ]
      },
      {
        riotId: 'PlayerTwo#EUW',
        championName: 'Darius',
        team: '200',
        items: 'invalid-not-array'
      }
    ],
    events: {
      Events: [
        { EventID: 1, EventName: 'GameStart', EventTime: 0 },
        { EventID: 2, EventName: 'MinionsSpawning', EventTime: 65.0 },
        { EventID: 3, EventName: 'FirstBrick', EventTime: 600.0, KillerName: 'PlayerOne' },
        { EventID: 4, EventName: 'TurretKilled', EventTime: 650.0, KillerName: 'PlayerOne' },
        { EventID: 5, EventName: 'DragonKill', EventTime: 700.123, KillerName: 'PlayerOne', Recipient: 'ORDER' },
        { EventID: 6, EventName: 'BaronKill', EventTime: 1200.555, KillerName: 'PlayerTwo', Recipient: 'CHAOS' }
      ]
    }
  };

  const summary = summarizeGameData(rawFixture);

  // Active player riotId fallback
  assert.equal(summary.activePlayer.summonerName, 'HideOnBush#KR1');
  assert.equal(summary.activePlayer.championName, 'Zed');

  // Team 100 maps to ORDER, Team 200 maps to CHAOS
  assert.equal(summary.teams.ORDER.players.length, 1);
  assert.equal(summary.teams.ORDER.players[0].summonerName, 'PlayerOne#NA1');
  assert.deepEqual(summary.teams.ORDER.players[0].items, ['DoranBlade', 'Item 1055']);

  assert.equal(summary.teams.CHAOS.players.length, 1);
  assert.equal(summary.teams.CHAOS.players[0].summonerName, 'PlayerTwo#EUW');
  assert.deepEqual(summary.teams.CHAOS.players[0].items, []);

  // Events: only last 5
  assert.equal(summary.latestEvents.length, 5);
  assert.equal(summary.latestEvents[0].id, 2);
  assert.equal(summary.latestEvents[4].id, 6);
  assert.equal(summary.latestEvents[4].time, 1200.6);
  assert.equal(summary.latestEvents[4].victim, 'CHAOS');
});
