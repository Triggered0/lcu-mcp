# Phase 2: CDP Multi-Target Discovery and Screenshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `lol_cdp_targets` to discover all active CEF targets and `lol_cdp_screenshot` to capture client screenshots via CDP.

**Architecture:** Extend `src/cdp/discover.js` with `listTargets(port)`. Add `captureScreenshot` to `CdpClient`. Register `lol_cdp_targets` and `lol_cdp_screenshot` in `src/tools/dom.js` (or `src/tools/cdp.js`), returning MCP text and MCP image content.

**Tech Stack:** Node.js 22+, CDP `Page.captureScreenshot`, `@modelcontextprotocol/sdk`.

**Spec:** [docs/superpowers/specs/2026-09-08-cdp-screenshot-and-targets-design.md](file:///C:/Users/DELL/Desktop/lcu-mcp/docs/superpowers/specs/2026-09-08-cdp-screenshot-and-targets-design.md)

---

### Task 1: CDP Target Listing and Screenshot Client Logic

**Files:**
- Modify: `src/cdp/discover.js`
- Modify: `src/cdp/client.js`
- Modify: `tests/cdp-discover.test.js`
- Modify: `tests/cdp-client.test.js`

**Interfaces:**
- Produces:
  - `listTargets(port: number): Promise<Array<object>>`
  - `CdpClient.prototype.captureScreenshot(options?: { format?: string, quality?: number, clip?: object }): Promise<{ data: string, format: string }>`

- [x] **Step 1: Write failing tests in `tests/cdp-discover.test.js` and `tests/cdp-client.test.js`**
- [x] **Step 2: Run tests to verify failure**
- [x] **Step 3: Implement `listTargets` and `captureScreenshot`**
- [x] **Step 4: Run tests to verify pass**
- [x] **Step 5: Commit changes**

---

### Task 2: Tools Registration (`lol_cdp_targets` & `lol_cdp_screenshot`)

**Files:**
- Create/Modify: `src/tools/cdp.js` (or `src/tools/dom.js`)
- Modify: `src/index.js`
- Modify: `tests/tools-status.test.js`
- Create: `tests/tools-cdp.test.js`

**Interfaces:**
- Produces:
  - `registerCdpTools(server, ctx)` exposing `lol_cdp_targets` and `lol_cdp_screenshot`.
  - Updated server tool list with 18 tools total.

- [x] **Step 1: Write failing tests in `tests/tools-cdp.test.js`**
- [x] **Step 2: Run tests to verify failure**
- [x] **Step 3: Implement tool registrations with MCP image and text responses**
- [x] **Step 4: Run tests to verify pass**
- [x] **Step 5: Run full test suite (`npm test`)**
- [x] **Step 6: Commit changes**
