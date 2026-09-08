# Phase 1: UX Restart Tool and Dynamic CDP Port Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide zero-configuration developer ergonomics by adding dynamic CDP port discovery (Pengu config / process command-line inspection) and a dedicated `lol_restart_ux` MCP tool with readiness polling.

**Architecture:** Port resolution uses a 4-tier fallback hierarchy (explicit config/env > Pengu config file > Windows process CLI > 8888 default). `CdpClient` receives a dynamic resolver. `lol_restart_ux` safely drops existing CDP sockets, dispatches `POST /riotclient/kill-and-restart-ux` to LCU, and polls until both LCU API and CDP target are responsive.

**Tech Stack:** Node.js 22+, `@modelcontextprotocol/sdk`, `zod`, `node:test`, `child_process` / PowerShell.

**Spec:** [docs/superpowers/specs/2026-09-08-restart-ux-and-cdp-port-discovery-design.md](file:///C:/Users/DELL/Desktop/lcu-mcp/docs/superpowers/specs/2026-09-08-restart-ux-and-cdp-port-discovery-design.md)

## Global Constraints

- Never weaken TLS verification on `LcuClient`.
- Redact passwords and tokens from error messages and status snapshots (`redactSecrets`).
- `lol_restart_ux` is a first-class tool; do not require entry in `writeAllowlist`.
- All tests must run with Node's native runner (`npm test` / `node --test`).

---

### Task 1: Dynamic CDP Port Discovery

**Files:**
- Modify: `src/cdp/discover.js`
- Modify: `tests/cdp-discover.test.js`

**Interfaces:**
- Produces:
  - `readPenguConfig(path?: string): Promise<number | null>`
  - `findProcessCdpPort(options?: { execCmd?: (cmd: string) => Promise<string> }): Promise<number | null>`
  - `resolveCdpPort(options?: { config?: object, env?: object, forceRefresh?: boolean, readConfigFile?: typeof readPenguConfig, scanProcesses?: typeof findProcessCdpPort }): Promise<{ port: number, source: string }>`

- [ ] **Step 1: Write the failing tests for port discovery**

Add tests to `tests/cdp-discover.test.js`:

```js
import { readPenguConfig, findProcessCdpPort, resolveCdpPort, clearPortCache } from '../src/cdp/discover.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('readPenguConfig extracts RemoteDebuggingPort from config text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pengu-test-'));
  const filePath = join(dir, 'config');
  try {
    await writeFile(filePath, 'SomeKey=abc\nRemoteDebuggingPort=9001\nOtherKey=123\n');
    const port = await readPenguConfig(filePath);
    assert.equal(port, 9001);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readPenguConfig returns null for missing file or missing key', async () => {
  const missing = await readPenguConfig('C:\\non_existent_path_test\\config');
  assert.equal(missing, null);

  const dir = await mkdtemp(join(tmpdir(), 'pengu-test-'));
  const filePath = join(dir, 'config');
  try {
    await writeFile(filePath, 'SomeKey=abc\n');
    assert.equal(await readPenguConfig(filePath), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('findProcessCdpPort parses --remote-debugging-port from command line', async () => {
  const fakeExec = async () => 'LeagueClientUxRender.exe --type=renderer --remote-debugging-port=9222 --lang=en';
  const port = await findProcessCdpPort({ execCmd: fakeExec, platform: 'win32' });
  assert.equal(port, 9222);
});

test('findProcessCdpPort returns null when flag is missing or not win32', async () => {
  const fakeExec = async () => 'LeagueClientUxRender.exe --type=gpu-process';
  assert.equal(await findProcessCdpPort({ execCmd: fakeExec, platform: 'win32' }), null);
  assert.equal(await findProcessCdpPort({ execCmd: fakeExec, platform: 'linux' }), null);
});

test('resolveCdpPort adheres to priority order and caching', async () => {
  clearPortCache();
  // 1. Explicit config wins
  let res = await resolveCdpPort({ config: { cdpPort: 7777 } });
  assert.deepEqual(res, { port: 7777, source: 'explicit' });

  clearPortCache();
  // 2. Env var wins over file
  res = await resolveCdpPort({ env: { LCU_CDP_PORT: '7788' } });
  assert.deepEqual(res, { port: 7788, source: 'env' });

  clearPortCache();
  // 3. File wins over process
  res = await resolveCdpPort({
    readConfigFile: async () => 8899,
    scanProcesses: async () => 9988
  });
  assert.deepEqual(res, { port: 8899, source: 'pengu-config' });

  clearPortCache();
  // 4. Process wins over fallback
  res = await resolveCdpPort({
    readConfigFile: async () => null,
    scanProcesses: async () => 9988
  });
  assert.deepEqual(res, { port: 9988, source: 'process' });

  clearPortCache();
  // 5. Fallback
  res = await resolveCdpPort({
    readConfigFile: async () => null,
    scanProcesses: async () => null
  });
  assert.deepEqual(res, { port: 8888, source: 'fallback' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/cdp-discover.test.js`
Expected: FAIL with "readPenguConfig is not a function"

- [ ] **Step 3: Write minimal implementation in `src/cdp/discover.js`**

Implement `readPenguConfig`, `findProcessCdpPort`, `resolveCdpPort`, and `clearPortCache` in `src/cdp/discover.js`:

```js
import { readFile } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
export const DEFAULT_PENGU_CONFIG_PATH = 'C:\\Program Files\\Pengu Loader\\config';

let cachedPortResolution = null;

export function clearPortCache() {
  cachedPortResolution = null;
}

export async function readPenguConfig(path = process.env.PENGU_CONFIG_PATH ?? DEFAULT_PENGU_CONFIG_PATH) {
  try {
    const text = await readFile(path, 'utf8');
    const match = text.match(/^RemoteDebuggingPort\s*=\s*(\d+)/m);
    if (!match) return null;
    const port = Number(match[1]);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

export async function findProcessCdpPort({
  execCmd = async (cmd) => (await execAsync(cmd)).stdout,
  platform = process.platform
} = {}) {
  if (platform !== 'win32') return null;
  try {
    const cmd = 'powershell.exe -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process -Filter \\"Name LIKE \'LeagueClientUxRender%\'\\" | Select-Object -ExpandProperty CommandLine"';
    const output = await execCmd(cmd);
    if (typeof output !== 'string') return null;
    const match = output.match(/--remote-debugging-port=(\d+)/);
    if (!match) return null;
    const port = Number(match[1]);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

export async function resolveCdpPort({
  config = {},
  env = process.env,
  forceRefresh = false,
  readConfigFile = readPenguConfig,
  scanProcesses = findProcessCdpPort
} = {}) {
  if (!forceRefresh && cachedPortResolution !== null) {
    return cachedPortResolution;
  }

  if (env.LCU_CDP_PORT && /^\d+$/.test(env.LCU_CDP_PORT)) {
    const port = Number(env.LCU_CDP_PORT);
    cachedPortResolution = { port, source: 'env' };
    return cachedPortResolution;
  }

  if (Number.isInteger(config.cdpPort)) {
    cachedPortResolution = { port: config.cdpPort, source: 'explicit' };
    return cachedPortResolution;
  }

  const filePort = await readConfigFile();
  if (filePort !== null) {
    cachedPortResolution = { port: filePort, source: 'pengu-config' };
    return cachedPortResolution;
  }

  const procPort = await scanProcesses();
  if (procPort !== null) {
    cachedPortResolution = { port: procPort, source: 'process' };
    return cachedPortResolution;
  }

  cachedPortResolution = { port: 8888, source: 'fallback' };
  return cachedPortResolution;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/cdp-discover.test.js`
Expected: PASS all tests.

- [ ] **Step 5: Commit**

```bash
git add src/cdp/discover.js tests/cdp-discover.test.js
git commit -m "feat: add dynamic cdp port discovery from pengu config and process cli"
```

---

### Task 2: Config and CdpClient Dynamic Port Resolution

**Files:**
- Modify: `src/config.js`
- Modify: `src/cdp/client.js`
- Modify: `tests/config.test.js`
- Modify: `tests/cdp-client.test.js`

**Interfaces:**
- Consumes: `resolveCdpPort` from `src/cdp/discover.js`
- Produces:
  - `validateConfig`: accepts `'auto'`, `null`, or integer for `cdpPort` (default `'auto'`).
  - `CdpClient`: accepts `portResolver` callback or static `port`; exposes `async getPort()`.

- [ ] **Step 1: Write failing tests for config validation and CdpClient portResolver**

In `tests/config.test.js`, add:
```js
test('validateConfig accepts "auto" and null for cdpPort', () => {
  const autoCfg = validateConfig({ cdpPort: 'auto' });
  assert.equal(autoCfg.cdpPort, 'auto');
  const nullCfg = validateConfig({ cdpPort: null });
  assert.equal(nullCfg.cdpPort, 'auto');
});
```

In `tests/cdp-client.test.js`, add:
```js
test('CdpClient calls portResolver if provided', async () => {
  let resolved = false;
  const client = new CdpClient({
    portResolver: async () => {
      resolved = true;
      return 9999;
    },
    discover: async (port) => {
      assert.equal(port, 9999);
      return { id: 'T1', webSocketDebuggerUrl: 'ws://127.0.0.1:9999/t1' };
    },
    wsFactory: () => {
      const emitter = new EventEmitter();
      emitter.send = () => {};
      emitter.close = () => {};
      process.nextTick(() => emitter.emit('open'));
      return emitter;
    }
  });
  await client.attach();
  assert.equal(resolved, true);
  assert.equal(client.port, 9999);
  client.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/config.test.js tests/cdp-client.test.js`
Expected: FAIL due to config validation rejecting `'auto'` or `client.portResolver` not resolving.

- [ ] **Step 3: Implement changes in `src/config.js` and `src/cdp/client.js`**

In `src/config.js`:
- Change `DEFAULTS.cdpPort = 'auto'`.
- In `validateConfig`:
```js
if (config.cdpPort === null || config.cdpPort === 'auto') {
  config.cdpPort = 'auto';
} else if (!Number.isInteger(config.cdpPort) || config.cdpPort < 1 || config.cdpPort > 65535) {
  throw new Error(`Config "cdpPort" must be "auto" or an integer port, got ${JSON.stringify(config.cdpPort)}`);
}
```

In `src/cdp/client.js`:
- Accept `portResolver` in constructor:
```js
constructor({ port, portResolver, wsFactory = (url) => new WebSocket(url), discover = findPageTarget } = {}) {
  this.port = port;
  this.portResolver = portResolver;
  this.wsFactory = wsFactory;
  this.discover = discover;
}
```
- In `#connect()`:
```js
if (this.portResolver) {
  this.port = await this.portResolver();
}
const target = await this.discover(this.port);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/config.test.js tests/cdp-client.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.js src/cdp/client.js tests/config.test.js tests/cdp-client.test.js
git commit -m "feat: support dynamic portResolver in CdpClient and auto cdpPort config"
```

---

### Task 3: UX Restart Tool (`lol_restart_ux`)

**Files:**
- Create: `src/tools/ux.js`
- Create: `tests/tools-ux.test.js`

**Interfaces:**
- Consumes: `ctx.lcu`, `ctx.cdp`, `ctx.consoleTailer`, `guard`, `ok`, `fail`, `resolveCdpPort`, `findPageTarget`
- Produces: `registerUxTools(server, ctx)`

- [ ] **Step 1: Write failing tests for `lol_restart_ux`**

Create `tests/tools-ux.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerUxTools } from '../src/tools/ux.js';

function fakeUxContext(overrides = {}) {
  let lcuCalls = 0;
  let closedCdp = false;
  return {
    lcu: {
      request: async (method, path) => {
        if (path === '/riotclient/kill-and-restart-ux') {
          return { status: 204 };
        }
        lcuCalls += 1;
        return { status: 200, body: { region: 'TR' } };
      },
      get: async (path) => {
        lcuCalls += 1;
        return { status: 200, body: { region: 'TR' } };
      }
    },
    cdp: {
      close: () => { closedCdp = true; }
    },
    consoleTailer: {
      stop: () => {}
    },
    discoverPage: async () => ({ id: 'P1', title: 'League of Legends' }),
    resolvePort: async () => ({ port: 8888, source: 'pengu-config' }),
    secrets: () => [],
    cooldownMs: 10,
    pollIntervalMs: 10,
    ...overrides
  };
}

async function createUxServer(ctx) {
  const server = new McpServer({ name: 'test-ux', version: '0.1.0' });
  registerUxTools(server, ctx);
  const client = new Client({ name: 'test-client', version: '1.0' });
  const [cTransport, sTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(cTransport), server.server.connect(sTransport)]);
  return { client, server };
}

test('lol_restart_ux with waitForReady=false dispatches and returns immediately', async () => {
  const ctx = fakeUxContext();
  const { client } = await createUxServer(ctx);
  const result = await client.callTool({ name: 'lol_restart_ux', arguments: { waitForReady: false } });
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.restarted, true);
  assert.equal(data.waiting, false);
  await client.close();
});

test('lol_restart_ux with waitForReady=true polls and returns success', async () => {
  const ctx = fakeUxContext();
  const { client } = await createUxServer(ctx);
  const result = await client.callTool({ name: 'lol_restart_ux', arguments: { waitForReady: true, timeoutSeconds: 5 } });
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.success, true);
  assert.equal(data.lcuReady, true);
  assert.equal(data.cdpReady, true);
  assert.equal(data.cdpPort, 8888);
  await client.close();
});

test('lol_restart_ux handles ECONNRESET on kill endpoint cleanly', async () => {
  const ctx = fakeUxContext({
    lcu: {
      request: async () => {
        const err = new Error('read ECONNRESET');
        err.code = 'ECONNRESET';
        throw err;
      },
      get: async () => ({ status: 200, body: {} })
    }
  });
  const { client } = await createUxServer(ctx);
  const result = await client.callTool({ name: 'lol_restart_ux', arguments: { waitForReady: false } });
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.restarted, true);
  await client.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/tools-ux.test.js`
Expected: FAIL with "Cannot find module '../src/tools/ux.js'"

- [ ] **Step 3: Implement `src/tools/ux.js`**

Create `src/tools/ux.js`:
```js
import { z } from 'zod';
import { fail, guard, ok } from './result.js';
import { findPageTarget, resolveCdpPort } from '../cdp/discover.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isConnectionReset(err) {
  if (!err) return false;
  const msg = String(err.message ?? '');
  const code = String(err.code ?? err.cause?.code ?? '');
  return code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || msg.includes('ECONNRESET') || msg.includes('socket hang up');
}

export function registerUxTools(server, ctx) {
  server.registerTool(
    'lol_restart_ux',
    {
      title: 'Restart the League Client UX',
      description:
        'Terminates and restarts the League Client UX (frontend CEF renderers) via Riot Client. ' +
        'Essential when developing Pengu Loader plugins or recovering from a frozen interface.',
      inputSchema: {
        waitForReady: z.boolean().default(true).describe('Wait until both LCU API and CDP target are fully responsive after restart'),
        timeoutSeconds: z.number().int().min(2).max(60).default(20).describe('Maximum seconds to wait for UX readiness when waitForReady is true')
      }
    },
    guard(async ({ waitForReady = true, timeoutSeconds = 20 }) => {
      // 1. Proactively disconnect CDP sockets
      try { ctx.cdp?.close?.(); } catch {}
      try { ctx.consoleTailer?.stop?.(); } catch {}

      // 2. Dispatch restart to LCU
      try {
        await ctx.lcu.request('POST', '/riotclient/kill-and-restart-ux', {});
      } catch (err) {
        if (!isConnectionReset(err)) throw err;
      }

      if (!waitForReady) {
        return ok({
          restarted: true,
          waiting: false,
          message: 'Restart command sent to Riot Client UX'
        });
      }

      const start = Date.now();
      const deadline = start + timeoutSeconds * 1000;
      const cooldownMs = ctx.cooldownMs ?? 1500;
      const pollIntervalMs = ctx.pollIntervalMs ?? 500;
      const discoverPage = ctx.discoverPage ?? findPageTarget;
      const portResolver = ctx.resolvePort ?? (() => resolveCdpPort({ config: ctx.config, forceRefresh: true }));

      await sleep(cooldownMs);

      let lcuReady = false;
      let cdpReady = false;
      let resolvedPort = null;
      let targetTitle = null;

      while (Date.now() < deadline) {
        if (!lcuReady) {
          try {
            const resp = await ctx.lcu.get('/riotclient/region-locale');
            if (resp && resp.status >= 200 && resp.status < 300) {
              lcuReady = true;
            }
          } catch {}
        }

        if (lcuReady && !cdpReady) {
          try {
            const portInfo = await portResolver();
            resolvedPort = typeof portInfo === 'object' ? portInfo.port : portInfo;
            const target = await discoverPage(resolvedPort);
            if (target && target.id) {
              cdpReady = true;
              targetTitle = target.title ?? null;
              break;
            }
          } catch {}
        }

        await sleep(pollIntervalMs);
      }

      const durationMs = Date.now() - start;
      if (!lcuReady || !cdpReady) {
        return fail(
          `Timed out waiting for UX readiness after ${timeoutSeconds}s. ` +
          `LCU API ready: ${lcuReady}, CDP target ready: ${cdpReady} (port ${resolvedPort}).`
        );
      }

      return ok({
        success: true,
        durationMs,
        lcuReady,
        cdpReady,
        cdpPort: resolvedPort,
        targetTitle,
        message: 'League Client UX restarted and fully responsive'
      });
    }, ctx)
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/tools-ux.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/ux.js tests/tools-ux.test.js
git commit -m "feat: implement lol_restart_ux tool with readiness polling"
```

---

### Task 4: Server Integration, Status Snapshot & Suite Verification

**Files:**
- Modify: `src/index.js`
- Modify: `src/tools/status.js`
- Modify: `tests/tools-status.test.js`
- Modify: `tests/helpers/context.js`

**Interfaces:**
- Integrates all components into `buildContext` and `createServer`.
- Updates `lol_status` output to reflect dynamic CDP port and source.

- [ ] **Step 1: Write failing test for server tool list and status snapshot**

In `tests/tools-status.test.js`:
Update the expected list of tools to include `'lol_restart_ux'`:
```js
  assert.deepEqual(names, [
    'lol_cdp_console_start',
    'lol_cdp_console_stop',
    'lol_cdp_console_tail',
    'lol_dom_query',
    'lol_endpoints',
    'lol_eval',
    'lol_events_poll',
    'lol_events_start',
    'lol_events_stop',
    'lol_get',
    'lol_request',
    'lol_restart_ux',
    'lol_status',
    'lol_wamp_record_dump',
    'lol_wamp_record_start',
    'lol_wamp_record_stop'
  ]);
```

In `tests/helpers/context.js`:
Add `cdpPortSource: 'explicit'` or similar if needed.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/tools-status.test.js`
Expected: FAIL (missing `lol_restart_ux` from tool list)

- [ ] **Step 3: Implement wiring in `src/index.js` and `src/tools/status.js`**

In `src/index.js`:
- Import `registerUxTools` from `./tools/ux.js`.
- Import `resolveCdpPort` from `./cdp/discover.js`.
- In `buildContext`:
```js
const portResolver = async ({ forceRefresh = false } = {}) => {
  const resolved = await resolveCdpPort({ config, env, forceRefresh });
  return resolved.port;
};
const cdp = new CdpClient({ portResolver });
...
const consoleCdp = new CdpClient({ portResolver });
```
- In `createServer(ctx)`:
```js
registerUxTools(server, ctx);
```

In `src/tools/status.js`:
- Ensure `cdp` snapshot returns the active port from `cdp.port`.

- [ ] **Step 4: Run all tests to verify 100% pass**

Run: `npm test`
Expected: All tests pass without regressions.

- [ ] **Step 5: Commit**

```bash
git add src/index.js src/tools/status.js tests/tools-status.test.js tests/helpers/context.js
git commit -m "feat: integrate lol_restart_ux and dynamic port discovery into server"
```
