import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiveGameClient, GameNotRunningError } from '../src/game/client.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CA_PATH = resolve(HERE, '../certs/riotgames.pem');

test('GameNotRunningError has expected name and default message', () => {
  const err = new GameNotRunningError();
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'GameNotRunningError');
  assert.match(err.message, /Live game is not currently running/);

  const customErr = new GameNotRunningError('Custom not running message');
  assert.equal(customErr.name, 'GameNotRunningError');
  assert.equal(customErr.message, 'Custom not running message');
});

test('LiveGameClient exposes port and handles default and fallback CA', () => {
  const defaultClient = new LiveGameClient();
  assert.equal(defaultClient.port, 2999);

  const customClient = new LiveGameClient({ port: 3005 });
  assert.equal(customClient.port, 3005);

  // Missing CA should not throw during construction
  const missingCaClient = new LiveGameClient({ caPath: 'C:\\non-existent-ca-path.pem' });
  assert.equal(missingCaClient.port, 2999);
});

test('LiveGameClient detects ECONNREFUSED when game is not running', async () => {
  // Port 49999 is unbound
  const client = new LiveGameClient({ port: 49999, caPath: CA_PATH, timeoutMs: 500 });
  const running = await client.isGameRunning();
  assert.equal(running, false);

  await assert.rejects(
    () => client.getGameStats(),
    (err) => {
      assert.ok(err instanceof GameNotRunningError);
      assert.match(err.message, /Live game is not currently running/);
      return true;
    }
  );
});

test('LiveGameClient sends requests and parses responses from live server', async () => {
  const recordedRequests = [];
  const server = http.createServer((req, res) => {
    recordedRequests.push({ url: req.url, method: req.method, headers: req.headers });

    if (req.url === '/liveclientdata/gamestats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ gameMode: 'CLASSIC', gameTime: 120.5 }));
      return;
    }
    if (req.url === '/liveclientdata/allgamedata') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ gameData: {}, activePlayer: {}, allPlayers: [], events: [] }));
      return;
    }
    if (req.url === '/liveclientdata/activeplayer') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ summonerName: 'Faker', championName: 'Ahri' }));
      return;
    }
    if (req.url === '/liveclientdata/playerlist') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{ summonerName: 'Faker' }, { summonerName: 'Deft' }]));
      return;
    }
    if (req.url === '/liveclientdata/eventdata') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ Events: [{ EventID: 1, EventName: 'GameStart' }] }));
      return;
    }
    if (req.url === '/liveclientdata/eventdata?afterID=1') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ Events: [{ EventID: 2, EventName: 'ChampionKill' }] }));
      return;
    }
    if (req.url === '/liveclientdata/invalid-json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('invalid{json');
      return;
    }
    if (req.url === '/liveclientdata/404') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    if (req.url === '/liveclientdata/500') {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
      return;
    }
    if (req.url === '/liveclientdata/hang') {
      // Intentionally do not respond to trigger timeout
      return;
    }

    res.writeHead(404).end('Unhandled route');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const agent = new http.Agent();
    agent.protocol = 'https:';

    const client = new LiveGameClient({ port, agent, timeoutMs: 300 });

    // isGameRunning
    const isRunning = await client.isGameRunning();
    assert.equal(isRunning, true);

    // getGameStats
    const stats = await client.getGameStats();
    assert.deepEqual(stats, { gameMode: 'CLASSIC', gameTime: 120.5 });

    // getAllGameData
    const allData = await client.getAllGameData();
    assert.deepEqual(allData, { gameData: {}, activePlayer: {}, allPlayers: [], events: [] });

    // getActivePlayer
    const activePlayer = await client.getActivePlayer();
    assert.deepEqual(activePlayer, { summonerName: 'Faker', championName: 'Ahri' });

    // getPlayerList
    const players = await client.getPlayerList();
    assert.deepEqual(players, [{ summonerName: 'Faker' }, { summonerName: 'Deft' }]);

    // getEvents without cursor
    const events = await client.getEvents();
    assert.deepEqual(events, { Events: [{ EventID: 1, EventName: 'GameStart' }] });

    // getEvents with afterId
    const eventsAfter = await client.getEvents(1);
    assert.deepEqual(eventsAfter, { Events: [{ EventID: 2, EventName: 'ChampionKill' }] });

    // request endpoint normalization
    const normalized1 = await client.request('gamestats');
    assert.equal(normalized1.gameMode, 'CLASSIC');

    const normalized2 = await client.request('/gamestats');
    assert.equal(normalized2.gameMode, 'CLASSIC');

    const normalized3 = await client.request('liveclientdata/gamestats');
    assert.equal(normalized3.gameMode, 'CLASSIC');

    const normalized4 = await client.request('/liveclientdata/gamestats');
    assert.equal(normalized4.gameMode, 'CLASSIC');

    // Error on status >= 400
    await assert.rejects(
      () => client.request('404'),
      /Live game API returned HTTP 404: Not Found/
    );

    await assert.rejects(
      () => client.request('500'),
      /Live game API returned HTTP 500: Internal Server Error/
    );

    // Error on invalid JSON
    await assert.rejects(
      () => client.request('invalid-json'),
      /Failed to parse JSON response from \/liveclientdata\/invalid-json/
    );

    // Timeout triggers GameNotRunningError
    await assert.rejects(
      () => client.request('hang'),
      (err) => {
        assert.ok(err instanceof GameNotRunningError);
        return true;
      }
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
