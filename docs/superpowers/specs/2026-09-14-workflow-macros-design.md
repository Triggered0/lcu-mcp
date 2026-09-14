# Sub-project S5: Workflow Macro Automation (`lol_workflow_*`) Design Specification

## Overview

High-level automation against the League of Legends client frequently requires complex, multi-step orchestration across REST endpoints, WAMP event streams, and static data catalogs.

Without dedicated workflow macros:
- An LLM agent must perform 4–8 separate round-trip tool calls over stdio to inspect gameflow phase, find the active session, resolve player cell IDs, look up champion IDs, submit action patches, and verify state.
- Network latency or rapid client timers (such as the 10-second ready check countdown or 30-second pick phases) can cause timeouts or race conditions.
- Error handling across intermediate states requires substantial LLM context.

Sub-project S5 introduces the `lol_workflow_*` subsystem to `lcu-mcp`: a collection of robust, pre-conditioned, atomic workflow macros that accomplish common client tasks in single tool calls with rich outcome reporting and rollback safeguards.

---

## Architectural Principles

1. **Pre-condition Verification**:
   Every macro verifies prerequisite state before executing mutations (e.g., verifying that ready check is active before posting accept; verifying that champ select is in progress and local player has an active pick/ban action before issuing patch).
2. **Name & ID Resolution**:
   Where applicable (e.g., champion selection), macros accept either human-friendly names (`"Aatrox"`, `"Yasuo"`) or numeric IDs (`266`, `157`), leveraging the static data catalog or built-in resolvers.
3. **Idempotency & Safe Retries**:
   Repeating a macro call (e.g., accepting an already accepted ready check or applying an already active rune page) succeeds cleanly without error.
4. **House Rules Compliance**:
   - Node >= 24.0.0, strict ES modules (`"type": "module"`), explicit `.js` extensions.
   - Zero new runtime dependencies.
   - Every tool explicitly declares all 4 boolean MCP annotation hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`).
   - 100% offline, deterministic tests using mocked LCU HTTP clients.

---

## Component Architecture

```
src/
  workflow/
    matchmaking.js     # Ready check accept and queue coordination
    champ_select.js    # Champ select session lookup, action resolution, lock-in/hover
    runes.js           # Rune page discovery, mutation, creation, and activation
    lobby.js           # Lobby creation and matchmaking search dispatcher
  tools/
    workflow.js        # Tool registrations: lol_workflow_matchmaking_accept, lol_workflow_champ_select, lol_workflow_runes_set, lol_workflow_lobby
```

### 1. Matchmaking Workflow (`src/workflow/matchmaking.js`)
- `acceptReadyCheck(lcu)`:
  - Queries `GET /lol-matchmaking/v1/ready-check`.
  - If state is not `'InProgress'`, returns `{ success: false, state, message: 'Ready check is not currently in progress' }`.
  - If player already accepted (`playerResponse === 'Accepted'`), returns `{ success: true, state, playerResponse: 'Accepted', message: 'Ready check already accepted' }`.
  - Posts `POST /lol-matchmaking/v1/ready-check/accept`.
  - Returns `{ success: true, state: 'InProgress', playerResponse: 'Accepted', message: 'Matchmaking ready check accepted' }`.

### 2. Champion Select Workflow (`src/workflow/champ_select.js`)
- `pickOrBanChampion(lcu, staticData, { champion, type = 'pick', completed = true })`:
  - Queries `GET /lol-champ-select/v1/session`.
  - Resolves `championId`: if string, resolves case-insensitively via `staticData` or numeric cast.
  - Identifies `localPlayerCellId` and searches `actions` array:
    - Matches action where `actorCellId === localPlayerCellId`, `type === (type || 'pick')`, and `completed === false`.
  - If no eligible action is active: returns `{ success: false, inChampSelect: true, message: 'No active ' + type + ' action found for local player' }`.
  - Issues `PATCH /lol-champ-select/v1/session/actions/${action.id}` with `{ championId, completed }`.
  - Returns `{ success: true, actionId: action.id, type, championId, completed, message: completed ? 'Locked in champion' : 'Hovered champion' }`.

### 3. Runes / Perks Workflow (`src/workflow/runes.js`)
- `setRunePage(lcu, { name, primaryStyleId, subStyleId, selectedPerkIds, replace = true })`:
  - Validates perk layout (`primaryStyleId`, `subStyleId`, `selectedPerkIds`).
  - Queries `GET /lol-perks/v1/pages`.
  - If editable page found:
    `PUT /lol-perks/v1/pages/${page.id}` with `{ name: name || page.name, primaryStyleId, subStyleId, selectedPerkIds, current: true }`.
  - If no editable page found:
    `POST /lol-perks/v1/pages` with `{ name: name || 'Antigravity Runes', primaryStyleId, subStyleId, selectedPerkIds, isEditable: true, current: true }`.
  - Returns `{ success: true, pageId, name, primaryStyleId, subStyleId, selectedPerkIds, message: 'Rune page active' }`.

### 4. Lobby Workflow (`src/workflow/lobby.js`)
- `createLobby(lcu, { queueId, startMatchmaking = false })`:
  - Issues `POST /lol-lobby/v2/lobby` with `{ queueId }`.
  - If `startMatchmaking === true`:
    Issues `POST /lol-lobby/v2/lobby/matchmaking/search`.
  - Returns `{ success: true, queueId, matchmakingStarted: startMatchmaking, message: 'Lobby created' }`.

---

## Tool Definitions

All tools are prefixed with `lol_workflow_` and registered in `src/tools/workflow.js`:
1. `lol_workflow_matchmaking_accept`:
   - Annotations: `readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true`
2. `lol_workflow_champ_select`:
   - Annotations: `readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true`
3. `lol_workflow_runes_set`:
   - Annotations: `readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true`
4. `lol_workflow_lobby`:
   - Annotations: `readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true`
