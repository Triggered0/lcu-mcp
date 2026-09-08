# Phase 3: LCU Schema Introspection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `lol_schema` MCP tool backed by an in-memory cached `LcuSchemaService` querying `GET /swagger/v2/swagger.json`.

**Architecture:** `LcuSchemaService` in `src/lcu/schema.js` queries LCU for Swagger v2 definitions, caches the parsed tree in memory, supports path filtering, method filtering, model lookups, and auto-expands `$ref` links. `registerSchemaTool` in `src/tools/schema.js` exposes `lol_schema`.

**Tech Stack:** Node.js 22+, Swagger v2 / OpenAPI, `@modelcontextprotocol/sdk`.

**Spec:** [docs/superpowers/specs/2026-09-08-lcu-schema-design.md](file:///C:/Users/DELL/Desktop/lcu-mcp/docs/superpowers/specs/2026-09-08-lcu-schema-design.md)

---

### Task 1: LcuSchemaService Implementation

**Files:**
- Create: `src/lcu/schema.js`
- Create: `tests/lcu-schema.test.js`

**Interfaces:**
- Produces: `LcuSchemaService` class:
  - `constructor({ client })`
  - `fetchSchema({ refresh?: boolean }): Promise<object>`
  - `query({ path?: string, method?: string, model?: string, refresh?: boolean }): Promise<object>`
  - `dereference(node: object, definitions: object): object`

- [x] **Step 1: Write failing tests in `tests/lcu-schema.test.js`**
- [x] **Step 2: Run tests to verify failure**
- [x] **Step 3: Implement `src/lcu/schema.js`**
- [x] **Step 4: Run tests to verify pass**
- [x] **Step 5: Commit changes**

---

### Task 2: Schema Tool Registration (`lol_schema`)

**Files:**
- Create: `src/tools/schema.js`
- Modify: `src/index.js`
- Modify: `tests/helpers/context.js`
- Modify: `tests/tools-status.test.js`
- Create: `tests/tools-schema.test.js`

**Interfaces:**
- Produces: `registerSchemaTools(server, ctx)` in `src/tools/schema.js`.
- Updates tool list to 19 tools.

- [ ] **Step 1: Write failing tests in `tests/tools-schema.test.js`**
- [ ] **Step 2: Run tests to verify failure**
- [ ] **Step 3: Implement `src/tools/schema.js` and wire in `src/index.js`**
- [ ] **Step 4: Run tests to verify pass**
- [ ] **Step 5: Run full test suite (`npm test`)**
- [ ] **Step 6: Commit changes**
