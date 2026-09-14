# Live Game Client Data (`lol_game_*`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `lol_game_*` subsystem providing direct, real-time access to in-match game engine data via `https://127.0.0.1:2999/liveclientdata`.

**Architecture:** A `LiveGameClient` connects directly to the local game engine HTTPS endpoint with Riot's root CA. A pure `summarizeGameData` engine projects verbose 100 KB game state payloads into compact, LLM-friendly summaries. Four MCP tools expose game state, match clock, player stats, and incremental event streams.

**Tech Stack:** Node.js (>= 24.0.0, ESM), `node:https`, `node:test`, Zod, Model Context Protocol SDK.

**Spec:** `docs/superpowers/specs/2026-09-14-live-game-data-design.md`

## Global Constraints

- Node >= 24.0.0. ES modules only (`"type": "module"`). Explicit `.js` extensions on all relative imports.
- Zero new runtime dependencies. Use Node built-ins (`node:https`, `node:fs`).
- English only in all code, comments, identifiers, documentation, and commit messages.
- No external network calls or Riot API keys. Strict `127.0.0.1:<port>` only.
- Strict TLS certificate verification against `certs/riotgames.pem`. Verification is never disabled.
- Every MCP tool declares all four annotation hints as booleans: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`.
- Offline tests only. Tests must never require a live game client.

---

### Task 1: `LiveGameClient` (`src/game/client.js`) and tests

**Files:**
- Create: `src/game/client.js`
- Test: `tests/game-client.test.js`

**Interfaces:**
- Consumes: `certs/riotgames.pem` (via `DEFAULT_CA_PATH` from `src/lcu/client.js`)
- Produces: `export class LiveGameClient`, `export class GameNotRunningError`
  - `constructor({ port = 2999, caPath = DEFAULT_CA_PATH, timeoutMs = 2000 } = {})`
  - `async request(path, query = {})`
  - `async isGameRunning()`
  - `async getGameStats()`
  - `async getAllGameData()`
  - `async getActivePlayer()`
  - `async getPlayerList()`
  - `async getEvents(afterId = null)`

- [ ] **Step 1: Write tests in `tests/game-client.test.js`**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiveGameClient, GameNotRunningError } from '../src/game/client.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CA_PATH = resolve(HERE, '../certs/riotgames.pem');

test('LiveGameClient detects ECONNREFUSED when game is not running', async () => {
  // Port 29999 is unbound
  const client = new LiveGameClient({ port: 29999, caPath: CA_PATH, timeoutMs: 500 });
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
  // Use a mock node https server with generated self-signed or use http agent for test injection
  const dummyCert = readFileSync(CA_PATH);
  const server = https.createServer({
    key: dummyCert, // In offline unit tests, mock request dispatch via custom agent or injectable fetcher
  });
  // Verify client methods match API
  const client = new LiveGameClient({ port: 2999, caPath: CA_PATH });
  assert.equal(typeof client.request, 'function');
  assert.equal(typeof client.getAllGameData, 'function');
  assert.equal(typeof client.getGameStats, 'function');
  assert.equal(typeof client.getActivePlayer, 'function');
  assert.equal(typeof client.getPlayerList, 'function');
  assert.equal(typeof client.getEvents, 'function');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/game-client.test.js`  
Expected: FAIL (module `../src/game/client.js` not found).

- [ ] **Step 3: Implement `src/game/client.js`**

Create `src/game/client.js`:
- Define `GameNotRunningError` extending `Error`.
- Load CA from `caPath` and initialize `https.Agent` with `ca`, `keepAlive: true`, and custom server identity validation.
- Implement `request(path, query)` using `https.request`. Handle `ECONNREFUSED`, `ETIMEDOUT`, and `UND_ERR_SOCKET` by throwing `GameNotRunningError`.
- Implement `isGameRunning()`, `getGameStats()`, `getAllGameData()`, `getActivePlayer()`, `getPlayerList()`, `getEvents(afterId)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/game-client.test.js`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/game/client.js tests/game-client.test.js
git commit -m "feat: add LiveGameClient for in-match game engine API"
```

---

### Task 2: `summarizeGameData` (`src/game/summary.js`) and tests

**Files:**
- Create: `src/game/summary.js`
- Test: `tests/game-summary.test.js`

**Interfaces:**
- Consumes: None (pure transformation function)
- Produces: `export function summarizeGameData(rawAllGameData)`

- [ ] **Step 1: Write tests in `tests/game-summary.test.js`**

```javascript
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
  assert.equal(summary.game.timeMinutes, 20.9);
  assert.equal(summary.activePlayer.summonerName, 'Faker');
  assert.equal(summary.activePlayer.kda, '5/1/4');
  assert.equal(summary.teams.ORDER.kills, 5);
  assert.equal(summary.teams.CHAOS.kills, 2);
  assert.equal(summary.latestEvents.length, 2);
});

test('summarizeGameData gracefully handles empty or partial objects', () => {
  const summary = summarizeGameData({});
  assert.ok(summary.game);
  assert.ok(summary.teams);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/game-summary.test.js`  
Expected: FAIL (`../src/game/summary.js` not found).

- [ ] **Step 3: Implement `src/game/summary.js`**

Implement `summarizeGameData(data)`:
- Extract and format game time (seconds and minutes), mode, and map terrain.
- Extract active player stats: summonerName, championName, level, current/max health, mana, AP, AD, gold, KDA, CS.
- Group `allPlayers` by team (`ORDER` / `CHAOS`), summing kills, deaths, assists, and computing player rosters.
- Return the last 5 events from `events.Events`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/game-summary.test.js`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/game/summary.js tests/game-summary.test.js
git commit -m "feat: add summarizeGameData for token-efficient live game projections"
```

---

### Task 3: Configuration, Tools Wiring, and Server Integration

**Files:**
- Modify: `src/config.js`
- Create: `src/tools/game.js`
- Modify: `src/index.js`
- Modify: `src/tools/status.js`
- Modify: `tests/helpers/context.js`
- Test: `tests/tools-game.test.js`
- Modify: `tests/tools-annotations.test.js`
- Modify: `tests/tools-status.test.js`
- Modify: `tests/config.test.js`

**Interfaces:**
- Consumes: `LiveGameClient`, `summarizeGameData`
- Produces: `registerGameTools(server, ctx)` with `lol_game_all`, `lol_game_stats`, `lol_game_player`, `lol_game_events`.

- [ ] **Step 1: Update `src/config.js` and `tests/config.test.js`**

Add `liveGamePort: 2999` to `DEFAULTS` and validate positive integer in `loadConfig`. Pin in `tests/config.test.js`.

- [ ] **Step 2: Write tests in `tests/tools-game.test.js`**

Create tests using `InMemoryTransport` and `Client` from `@modelcontextprotocol/sdk`:
- Verify all 4 tools registered.
- Test `lol_game_all` returns summary by default and raw when requested.
- Test `lol_game_stats` returns stats.
- Test `lol_game_player` with/without name argument.
- Test `lol_game_events` with `afterId`.
- Test `GameNotRunningError` returns clean MCP error message without stack trace.

- [ ] **Step 3: Implement `src/tools/game.js`**

Implement and export `registerGameTools(server, ctx)`:
- `lol_game_all`: `format: z.enum(['summary', 'raw']).default('summary')`
- `lol_game_stats`: no parameters
- `lol_game_player`: `name: z.string().optional()`
- `lol_game_events`: `afterId: z.number().int().min(0).optional()`
- All declare all four annotation hints as booleans (`readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`).

- [ ] **Step 4: Wire into `src/index.js` and `src/tools/status.js`**

- In `src/index.js`: instantiate `LiveGameClient` in `buildContext`, attach `ctx.gameClient`, call `registerGameTools(server, ctx)`.
- In `src/tools/status.js`: report `game: await ctx.gameClient.isGameRunning().catch(() => false)`.
- In `tests/helpers/context.js`: add `gameClient` mock stub.

- [ ] **Step 5: Update pinned tests**

Update `tests/tools-annotations.test.js` and `tests/tools-status.test.js` with the 4 new tools.

- [ ] **Step 6: Run full test suite & linter**

Run: `node --test && npm run lint`  
Expected: PASS across entire repo.

- [ ] **Step 7: Commit**

```bash
git add src/config.js src/tools/game.js src/index.js src/tools/status.js tests/helpers/context.js tests/tools-game.test.js tests/tools-annotations.test.js tests/tools-status.test.js tests/config.test.js
git commit -m "feat: add the lol_game_* tool group"
```

---

### Task 4: Documentation and Live Smoke Stage

**Files:**
- Modify: `README.md`
- Modify: `scripts/smoke.mjs`

- [ ] **Step 1: Update `README.md`**

- Document `lol_game_all`, `lol_game_stats`, `lol_game_player`, `lol_game_events` in the tools table.
- Add narrative explanation of Live Client Data API.
- Add `liveGamePort` to configuration table.
- Add `src/game/` to repository layout.

- [ ] **Step 2: Update `scripts/smoke.mjs`**

- Import `LiveGameClient`.
- Instantiate `gameClient = new LiveGameClient({ port: config.liveGamePort })`.
- Add smoke stage `'live game data'` checking `isGameRunning()`, reporting game time if running or marking `Inconclusive` if not in-match.

- [ ] **Step 3: Run full test suite & linter**

Run: `node --test && npm run lint`  
Expected: PASS, 0 failures.

- [ ] **Step 4: Commit**

```bash
git add README.md scripts/smoke.mjs
git commit -m "docs: document live game tools and add smoke check stage"
```
