# Sub-project S5: Workflow Macro Automation (`lol_workflow_*`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement high-level, pre-conditioned workflow macros (`lol_workflow_*`) for matchmaking ready check, champion select pick/ban, rune page configuration, and lobby creation.

**Architecture:** Modular workflow execution modules in `src/workflow/` encapsulate pre-condition inspection, endpoint mutation, and outcome verification. The tools layer in `src/tools/workflow.js` exposes these workflows to the MCP server with complete annotation hints.

**Tech Stack:** Node.js >= 24.0.0, ES Modules, MCP SDK (`@modelcontextprotocol/sdk`), Zod, Node test runner (`node:test`).

**Spec:** `docs/superpowers/specs/2026-09-14-workflow-macros-design.md`

## Global Constraints

- Node >= 24.0.0. ES modules only ("type": "module"). Explicit .js extensions on relative imports.
- Zero new runtime dependencies.
- English only in all code, comments, identifiers, docs and commit messages.
- Every tool declares all four annotation hints as booleans: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`.
- All 4 workflow tools have: `readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true`.
- Tests must stay 100% offline and deterministic.

---

### Task 1: Core Workflow Engines (`src/workflow/`)

**Files:**
- Create: `src/workflow/matchmaking.js`
- Create: `src/workflow/champ_select.js`
- Create: `src/workflow/runes.js`
- Create: `src/workflow/lobby.js`
- Create: `tests/workflow-matchmaking.test.js`
- Create: `tests/workflow-champ-select.test.js`
- Create: `tests/workflow-runes.test.js`
- Create: `tests/workflow-lobby.test.js`

**Interfaces:**
- Produces:
  - `acceptReadyCheck(lcu)` in `src/workflow/matchmaking.js`
  - `pickOrBanChampion(lcu, staticData, { champion, type, completed })` in `src/workflow/champ_select.js`
  - `setRunePage(lcu, { name, primaryStyleId, subStyleId, selectedPerkIds, replace })` in `src/workflow/runes.js`
  - `createLobby(lcu, { queueId, startMatchmaking })` in `src/workflow/lobby.js`

- [ ] **Step 1: Write tests for matchmaking, champ select, runes, and lobby workflows**
- [ ] **Step 2: Run tests to verify they fail**
- [ ] **Step 3: Implement workflow modules in `src/workflow/`**
- [ ] **Step 4: Run tests to verify all unit suites pass (GREEN)**
- [ ] **Step 5: Commit**
```bash
git add src/workflow/ tests/workflow-*.test.js
git commit -m "feat(workflow): implement core matchmaking, champ select, runes, and lobby workflow engines"
```

---

### Task 2: MCP Tools Wiring & Server Registration (`src/tools/workflow.js`)

**Files:**
- Create: `src/tools/workflow.js`
- Modify: `src/index.js`
- Create: `tests/tools-workflow.test.js`
- Modify: `tests/tools-annotations.test.js`
- Modify: `tests/tools-status.test.js`

**Interfaces:**
- Consumes: workflow functions from `src/workflow/`
- Produces:
  - Tool `lol_workflow_matchmaking_accept`
  - Tool `lol_workflow_champ_select`
  - Tool `lol_workflow_runes_set`
  - Tool `lol_workflow_lobby`

- [ ] **Step 1: Write integration tests in `tests/tools-workflow.test.js`**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement `src/tools/workflow.js` and register in `src/index.js`**
- [ ] **Step 4: Update annotation and status test suites**
- [ ] **Step 5: Run full test suite and verify 100% pass**
- [ ] **Step 6: Commit**
```bash
git add src/tools/workflow.js src/index.js tests/tools-workflow.test.js tests/tools-annotations.test.js tests/tools-status.test.js
git commit -m "feat(workflow): register lol_workflow_* tools in server"
```

---

### Task 3: Documentation & Smoke Tests

**Files:**
- Modify: `README.md`
- Modify: `scripts/smoke.mjs`

- [ ] **Step 1: Document all 4 workflow tools in `README.md`**
- [ ] **Step 2: Add smoke checks in `scripts/smoke.mjs`**
- [ ] **Step 3: Run whole repository tests and linter (`npm test && npm run lint`)**
- [ ] **Step 4: Commit**
```bash
git add README.md scripts/smoke.mjs
git commit -m "docs(workflow): document workflow macros and add smoke stage"
```
