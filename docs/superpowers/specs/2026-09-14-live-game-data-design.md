# Sub-project S3: Live Game Client Data (`lol_game_*`) Design Specification

## Overview

When League of Legends enters a live match (loading screen, Summoner's Rift, ARAM, Practice Tool, or TFT), the game executable (`LeagueofLegends.exe`) hosts an internal HTTPS server on `https://127.0.0.1:2999/liveclientdata`.

This API provides instantaneous, tick-by-tick access to match state directly from the game engine. Unlike the LCU REST API (which focuses on client UI, champion select, matchmaking, and chat), the Live Client Data API exposes:
- Active player real-time stats, abilities, cooldowns, runes, and gold.
- All players' champions, items, K/D/A, creep score, and spell cooldowns.
- In-game combat and objective events (champion kills, first blood, multi-kills, dragons, barons, rift heralds, turrets, and aces).
- Match time, game mode, map terrain, and paused state.

This specification introduces the `lol_game_*` subsystem to `lcu-mcp`.

---

## Architectural Principles

1. **Localhost Only, Zero Internet**:
   All communication is restricted to `127.0.0.1:<liveGamePort>` (default `2999`). No external network requests or Riot API keys are used.

2. **TLS Verification with Pinned CA**:
   Requests are made over HTTPS using Riot's root CA vendored at `certs/riotgames.pem`. To accommodate certificates issued to Riot's internal subject names on `127.0.0.1`, TLS certificate chain validation remains strictly enforced against Riot's CA with custom server identity verification. Verification is never disabled (`rejectUnauthorized` is never set to `false`).

3. **Token Conservation via Structured Summarization**:
   The full `/liveclientdata/allgamedata` endpoint returns 50–100 KB of verbose JSON per call. By default, `lol_game_all` projects this into a compact, human- and LLM-friendly summary showing match clock, team comparisons, scores, items, and active player vital stats. The full raw JSON is accessible when `format: 'raw'` is requested.

4. **Incremental Event Polling**:
   `/liveclientdata/eventdata` supports `afterID` filtering. `lol_game_events` tracks and exposes event IDs so callers can incrementally tail combat and objective feeds without re-reading past events.

5. **Graceful Match-State Detection**:
   When no match is currently running, port 2999 is closed (`ECONNREFUSED`). Rather than throwing a bare socket error, the subsystem detects this state and returns a structured message indicating the game engine is not running.

6. **House Rules Compliance**:
   - Node >= 24.0.0, strict ES modules (`"type": "module"`), explicit `.js` extensions.
   - Zero new runtime dependencies (uses `node:https`).
   - Every tool explicitly declares all 4 MCP annotation hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`).
   - Offline tests only (mock HTTP/HTTPS servers).

---

## Component Architecture

```
src/
  game/
    client.js       # LiveGameClient: HTTPS agent, request dispatcher, connection detection
    summary.js      # Pure summarizer: transforms verbose allgamedata into token-efficient summaries
  tools/
    game.js         # Tool definitions: lol_game_all, lol_game_stats, lol_game_player, lol_game_events
```

### 1. `src/game/client.js` (`LiveGameClient`)
Responsible for issuing HTTPS requests to `https://127.0.0.1:<port>/liveclientdata`.

- **Constructor**:
  ```js
  new LiveGameClient({
    port = 2999,
    caPath = DEFAULT_CA_PATH,
    timeoutMs = 2000
  })
  ```
- **Methods**:
  - `async request(path, query = {})`: Issues GET request to `/liveclientdata/${path}`.
  - `async isGameRunning()`: Probes `/liveclientdata/gamestats` with short timeout. Returns `boolean`.
  - `async getGameStats()`: Returns `/liveclientdata/gamestats`.
  - `async getAllGameData()`: Returns `/liveclientdata/allgamedata`.
  - `async getActivePlayer()`: Returns `/liveclientdata/activeplayer`.
  - `async getPlayerList()`: Returns `/liveclientdata/playerlist`.
  - `async getEvents(afterId = null)`: Returns `/liveclientdata/eventdata?afterID=${afterId}`.
- **Error Handling**:
  - `ECONNREFUSED` or `ETIMEDOUT` is wrapped into a distinct `GameNotRunningError` with the friendly message:
    `"Live game is not currently running. The Live Client Data API is only active during matches."`

### 2. `src/game/summary.js` (`summarizeGameData`)
Pure function transforming raw `allgamedata` JSON into an informative, compact object:
- `game`: `{ time: number, mode: string, terrain: string, paused: boolean }`
- `activePlayer`: `{ summonerName, championName, level, currentHealth, maxHealth, resourceValue, resourceMax, currentGold, kda: { kills, deaths, assists }, creepScore }`
- `teams`: Summary of Order (`100`) and Chaos (`200`) teams:
  - Total kills, approximate team gold, towers destroyed, dragons taken, barons taken.
  - Players roster: `[ { summonerName, championName, team, level, kda, items: [name], creepScore } ]`
- `latestEvents`: The most recent 5 objective/kill events.

---

## Tool Definitions

All tools are prefixed with `lol_game_` and registered in `src/tools/game.js`.

### 1. `lol_game_all`
- **Description**: "Fetch full real-time live game state from the in-match game engine (scores, players, items, events, game time)."
- **Parameters**:
  - `format`: `z.enum(['summary', 'raw']).default('summary')`
- **Annotations**:
  - `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`

### 2. `lol_game_stats`
- **Description**: "Check match status and general game clock/mode from the live game engine."
- **Parameters**: None
- **Annotations**:
  - `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`

### 3. `lol_game_player`
- **Description**: "Fetch real-time stats, abilities, items, and runes for the active player or a specific summoner."
- **Parameters**:
  - `name`: `z.string().optional().describe('Summoner name, or omit for local active player')`
- **Annotations**:
  - `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`

### 4. `lol_game_events`
- **Description**: "Retrieve in-game events (kills, objectives, aces, structures) with incremental cursor support."
- **Parameters**:
  - `afterId`: `z.number().int().min(0).optional().describe('Event ID cursor to fetch events that occurred after')`
- **Annotations**:
  - `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`

---

## Configuration & Server Wiring

- **`src/config.js`**:
  - Add `liveGamePort: 2999` to `DEFAULTS`.
  - Add positive integer validation.
- **`src/index.js`**:
  - Build `LiveGameClient` in `buildContext` using `config.liveGamePort`.
  - Expose `gameClient` in context.
  - Register tools via `registerGameTools(server, ctx)`.
- **`src/tools/status.js`**:
  - Add `game: await ctx.gameClient.isGameRunning().catch(() => false)`.

---

## Test Plan

1. **`tests/game-client.test.js`**:
   - Mock HTTPS server using pinned CA.
   - Successful GET calls (`/liveclientdata/allgamedata`, `/gamestats`, `/eventdata`).
   - Query parameter forwarding (`afterID`).
   - Handling `ECONNREFUSED` when mock server is stopped -> returns `GameNotRunningError`.
   - Error forwarding on HTTP 404 or 500.

2. **`tests/game-summary.test.js`**:
   - Summary transformation over realistic raw `allgamedata` mock fixture.
   - Computes team stats, formats player roster, extracts vital stats.
   - Tolerates missing or partial fields gracefully.

3. **`tests/tools-game.test.js`**:
   - MCP tool invocation over `InMemoryTransport`.
   - Argument forwarding and default formatting.
   - All 4 MCP annotation hints verified.
   - `GameNotRunningError` translates into clean, informative MCP output.

4. **Integration & Server Regression**:
   - `tests/tools-annotations.test.js` pins the 4 new tools.
   - `tests/tools-status.test.js` pins the updated tool list and status snapshot.
   - `tests/config.test.js` pins `liveGamePort: 2999`.
