# Phase 4: Forensics Correlator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `lol_forensics_correlate` MCP tool combining WAMP recorder events and CDP console entries into a unified chronological narrative.

**Architecture:** `src/forensics/correlate.js` normalizes, sorts, and formats entries from `ctx.recorder` and `ctx.consoleTailer`. `src/tools/forensics.js` exposes the `lol_forensics_correlate` tool.

**Tech Stack:** Node.js 22+, `@modelcontextprotocol/sdk`.

**Spec:** [docs/superpowers/specs/2026-09-08-forensics-correlate-design.md](file:///C:/Users/DELL/Desktop/lcu-mcp/docs/superpowers/specs/2026-09-08-forensics-correlate-design.md)

---

### Task 1: Timeline Correlation Engine

**Files:**
- Create: `src/forensics/correlate.js`
- Create: `tests/forensics-correlate.test.js`

**Interfaces:**
- Produces:
  - `correlateTimelines({ wampEntries, cdpEntries, limit, format }): object | string`
  - `formatNarrativeLine(entry): string`

- [x] **Step 1: Write failing tests in `tests/forensics-correlate.test.js`**
- [x] **Step 2: Run tests to verify failure**
- [x] **Step 3: Implement `src/forensics/correlate.js`**
- [x] **Step 4: Run tests to verify pass**
- [x] **Step 5: Commit changes**

---

### Task 2: Forensics Tool Registration (`lol_forensics_correlate`)

**Files:**
- Create: `src/tools/forensics.js`
- Modify: `src/index.js`
- Modify: `tests/helpers/context.js`
- Modify: `tests/tools-status.test.js`
- Create: `tests/tools-forensics.test.js`

**Interfaces:**
- Produces: `registerForensicsTools(server, ctx)` in `src/tools/forensics.js`.
- Updates tool count to 20 tools.

- [x] **Step 1: Write failing tests in `tests/tools-forensics.test.js`**
- [x] **Step 2: Run tests to verify failure**
- [x] **Step 3: Implement `src/tools/forensics.js` and wire in `src/index.js`**
- [x] **Step 4: Run tests to verify pass**
- [x] **Step 5: Run full test suite (`npm test`)**
- [x] **Step 6: Commit changes**
