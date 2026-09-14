# Sub-project S4: Unified Multi-Stream Forensics (`lol_forensics_*`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the forensics engine to correlate across all five telemetry streams (WAMP, CDP console, CDP network, disk logs, and live game events) and introduce `lol_forensics_bundle` for comprehensive diagnostic incident capture.

**Architecture:** A pure correlation engine in `src/forensics/correlate.js` normalizes, aligns, and projects disparate event types onto a unified wall-clock timeline. A bundle builder in `src/forensics/bundle.js` aggregates system status, timeline slices, and disk log fallbacks into structured Markdown or JSON. Two MCP tools in `src/tools/forensics.js` expose these capabilities with complete MCP annotation hints.

**Tech Stack:** Node.js >= 24.0.0, ES Modules, MCP SDK (`@modelcontextprotocol/sdk`), Zod, Node test runner (`node:test`).

**Spec:** `docs/superpowers/specs/2026-09-14-unified-forensics-design.md`

## Global Constraints

- Node >= 24.0.0. ES modules only ("type": "module"). Explicit .js extensions on relative imports.
- Zero new runtime dependencies.
- English only in all code, comments, identifiers, docs and commit messages.
- Every tool declares all four annotation hints as booleans: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`.
- All secrets and credentials scrubbed via ingest-time and bundle-time redaction.
- Tests must stay 100% offline and deterministic.

---

### Task 1: Multi-Stream Timeline Correlation Engine (`src/forensics/correlate.js`)

**Files:**
- Modify: `src/forensics/correlate.js`
- Modify: `tests/forensics-correlate.test.js`

**Interfaces:**
- Produces:
  - `normalizeNetworkEntry(entry)`
  - `normalizeLogEntry(entry)`
  - `normalizeGameEntry(entry)`
  - `formatNarrativeLine(entry)`
  - `correlateTimelines({ wampEntries, cdpEntries, networkEntries, logEntries, gameEntries, limit, sources, levels, format })`

- [ ] **Step 1: Write failing tests for multi-stream normalization and correlation**

Update `tests/forensics-correlate.test.js` with tests for:
- `normalizeNetworkEntry`: request with status, duration, error text; reattach entry.
- `normalizeLogEntry`: target, level, message, wallTime parsing.
- `normalizeGameEntry`: event name, game time, killer, victim.
- `formatNarrativeLine`: formats each source prefix: `[WAMP:...]`, `[CDP:...]`, `[NETWORK:...]`, `[LOGS:...]`, `[GAME:...]`.
- `correlateTimelines`:
  - Merges entries from all streams chronologically by timestamp.
  - Filters by `sources: ['network', 'logs']`.
  - Generates `summary` format with per-source counts and `errorCount`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/forensics-correlate.test.js`
Expected: FAIL due to missing `normalizeNetworkEntry` and missing stream support in `correlateTimelines`.

- [ ] **Step 3: Implement multi-stream correlation in `src/forensics/correlate.js`**

Implement `normalizeNetworkEntry`, `normalizeLogEntry`, `normalizeGameEntry`, update `formatNarrativeLine`, and update `correlateTimelines` to ingest `networkEntries`, `logEntries`, and `gameEntries`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/forensics-correlate.test.js`
Expected: PASS with 100% tests green.

- [ ] **Step 5: Commit**

```bash
git add src/forensics/correlate.js tests/forensics-correlate.test.js
git commit -m "feat(forensics): expand correlation engine to support network, logs, and game streams"
```

---

### Task 2: Diagnostic Bundle Generator (`src/forensics/bundle.js`)

**Files:**
- Create: `src/forensics/bundle.js`
- Create: `tests/forensics-bundle.test.js`

**Interfaces:**
- Consumes:
  - `correlateTimelines` from `src/forensics/correlate.js`
  - `redactSecrets` from `src/redact.js`
- Produces:
  - `export async function createForensicsBundle(ctx, options = {})`

- [ ] **Step 1: Write failing tests for bundle generator**

Create `tests/forensics-bundle.test.js` testing:
- System status collection (LCU connection, CDP attachment, watchers running).
- Timeline gathering across available buffers.
- Disk log fallback when watcher is inactive.
- Secret redaction (ensuring tokens and passwords do not appear in markdown or JSON).
- Both `format: 'markdown'` and `format: 'json'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/forensics-bundle.test.js`
Expected: FAIL (module does not exist yet).

- [ ] **Step 3: Implement `src/forensics/bundle.js`**

Implement `createForensicsBundle(ctx, { since, until, limit = 200, sources = null, includeLogTail = true, format = 'markdown' })`:
- Inspects `ctx.lcu`, `ctx.cdp`, `ctx.gameClient`, `ctx.recorder`, `ctx.consoleTailer`, `ctx.networkTailer`, `ctx.logWatcher`, `ctx.logReader`.
- Safely collects entries from running streams.
- Runs disk log fallback tail if needed.
- Computes correlated timeline.
- Generates Markdown report with alerts and stream breakdown or structured JSON.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/forensics-bundle.test.js`
Expected: PASS with 100% tests green.

- [ ] **Step 5: Commit**

```bash
git add src/forensics/bundle.js tests/forensics-bundle.test.js
git commit -m "feat(forensics): add diagnostic bundle generator"
```

---

### Task 3: MCP Tools Wiring & Server Integration (`src/tools/forensics.js`)

**Files:**
- Modify: `src/tools/forensics.js`
- Modify: `tests/tools-forensics.test.js`
- Modify: `tests/tools-annotations.test.js`
- Modify: `tests/tools-status.test.js`

**Interfaces:**
- Consumes: `createForensicsBundle` from `src/forensics/bundle.js`, `correlateTimelines` from `src/forensics/correlate.js`.
- Produces:
  - Tool `lol_forensics_correlate` (updated with `sources`, `networkFailedOnly`, `logLevel`)
  - Tool `lol_forensics_bundle` (new tool)

- [ ] **Step 1: Write tests for `lol_forensics_bundle` and updated `lol_forensics_correlate`**

Update `tests/tools-forensics.test.js` testing:
- `lol_forensics_correlate` with network and log sources.
- `lol_forensics_bundle` in markdown format.
- `lol_forensics_bundle` in json format.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/tools-forensics.test.js`
Expected: FAIL due to missing `lol_forensics_bundle` registration.

- [ ] **Step 3: Implement `src/tools/forensics.js` & update annotation/status tests**

- In `src/tools/forensics.js`, register `lol_forensics_bundle` and update `lol_forensics_correlate`.
- Define all 4 boolean annotation hints on both tools:
  `readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true`.
- In `tests/tools-annotations.test.js`, add `lol_forensics_bundle`.
- In `tests/tools-status.test.js`, add `lol_forensics_bundle` in alphabetical order.

- [ ] **Step 4: Run full test suite and lint**

Run: `npm test && npm run lint`
Expected: PASS with 0 failures and 0 lint warnings.

- [ ] **Step 5: Commit**

```bash
git add src/tools/forensics.js tests/tools-forensics.test.js tests/tools-annotations.test.js tests/tools-status.test.js
git commit -m "feat(forensics): register lol_forensics_bundle and expand correlate tool"
```

---

### Task 4: Documentation & Smoke Check

**Files:**
- Modify: `README.md`
- Modify: `scripts/smoke.mjs`

- [ ] **Step 1: Update `README.md` and `scripts/smoke.mjs`**

- Document `lol_forensics_correlate` options and `lol_forensics_bundle` usage.
- Add live smoke test step for forensics tools.

- [ ] **Step 2: Run smoke check or verification**

Run: `npm test && npm run lint`
Expected: All tests passing, 0 lint errors.

- [ ] **Step 3: Commit**

```bash
git add README.md scripts/smoke.mjs
git commit -m "docs(forensics): document multi-stream forensics and diagnostic bundle"
```
