# LCU MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a stdio MCP server that exposes a running League client's LCU REST API, its `OnJsonApiEvent` stream, and its CEF DOM/JS context as nine tools.

**Architecture:** One Node package, two independent subsystems in one process — `LcuClient` (lockfile discovery, TLS-pinned REST, WSS event tap into a ring buffer) and `CdpClient` (Pengu-enabled remote debugging port, `Runtime.evaluate`, DOM queries). Both lazy-connect and survive client restarts. Tools are thin: policy (write allowlist, `allowEval`, redaction) lives in the tool layer, transport lives in the subsystems.

**Tech Stack:** Node 24 (ESM, no build step), `@modelcontextprotocol/sdk`, `zod`, `ws`, `node:test` + `node:assert/strict`.

Source spec: `docs/superpowers/specs/2026-07-26-lcu-mcp-server-design.md`. Every fact in it was verified live on 2026-07-26; do not "correct" it from memory.

## Global Constraints

- Node `>=24.0.0`. ESM only — `"type": "module"` in `package.json`, `.js` extensions in every relative import. No TypeScript, no bundler, no transpile step.
- Runtime dependencies are exactly: `@modelcontextprotocol/sdk`, `zod`, `ws`. Dev dependencies: none (tests use `node:test`). Do not add a test framework, an HTTP client, or a CDP client library.
- Tests run with `npm test` → `node --test`. Unit tests must pass with **no** League client running.
- TLS verification against the LCU stays **on**, always. Riot's root CA is pinned via the `ca:` option. Never set `NODE_TLS_REJECT_UNAUTHORIZED`, never `rejectUnauthorized: false`, never override `checkServerIdentity`. The served cert is `CN=rclient`, issued by `LoL Game Engineering Certificate Authority`, `SAN: DNS:localhost, IP:127.0.0.1` — pinning the CA alone passes chain and hostname verification against `127.0.0.1`.
- The LCU password is a secret. It must never be logged, never returned by a tool, and never appear in an error message. CDP target URLs embed it (`https://riot:<password>@127.0.0.1:<port>/index.html`) and must be redacted at the boundary.
- Exactly nine tools, named exactly: `lol_status`, `lol_get`, `lol_request`, `lol_endpoints`, `lol_events_start`, `lol_events_poll`, `lol_events_stop`, `lol_dom_query`, `lol_eval`.
- Default lockfile path: `C:\Riot Games\League of Legends\lockfile`, format `name:pid:port:password:protocol`. The **directory** is watched, not the file — the file is deleted and recreated on client restart.
- Config file: `config/allowlist.json`, path overridable by `LCU_MCP_CONFIG`. Defaults: `allowEval: true`, `cdpPort: 8888`, `eventBufferSize: 1000`, `writeAllowlist: []`.
- Commit messages: Conventional Commits (`feat:`, `test:`, `chore:`, `docs:`). No Claude attribution trailers.

## File Structure

| File | Responsibility |
|---|---|
| `package.json` | ESM package, `npm test` → `node --test`, `bin`/`start` entry |
| `src/config.js` | Load + validate config file, apply defaults |
| `src/allowlist.js` | Pure write-allowlist matching + denial message |
| `src/redact.js` | Strip passwords from URLs and arbitrary strings |
| `src/lcu/lockfile.js` | Parse lockfile, read credentials, watch the directory |
| `src/lcu/client.js` | HTTPS REST against the LCU with pinned CA, credential caching |
| `src/lcu/buffer.js` | Ring buffer with seq cursor and `dropped` accounting |
| `src/lcu/ingest.js` | Pure ingest policy: URI prefix filters + 4 KB data truncation |
| `src/lcu/events.js` | WSS tap, frame decoding, reconnect with backoff |
| `src/cdp/discover.js` | Probe `/json/version` + `/json/list`, pick and redact the page target |
| `src/cdp/client.js` | Attach to the target, id-correlated `send`, `evaluate`, `domQuery` |
| `src/tools/result.js` | `ok`/`fail` shapes + error guard with redaction |
| `src/tools/status.js` | `lol_status` |
| `src/tools/passthrough.js` | `lol_get`, `lol_request` (allowlist enforcement point) |
| `src/tools/curated.js` | Curated endpoint table (data) + `filterEndpoints` |
| `src/tools/endpoints.js` | `lol_endpoints` |
| `src/tools/events.js` | `lol_events_start`, `lol_events_poll`, `lol_events_stop` |
| `src/tools/dom.js` | `lol_dom_query`, `lol_eval` (`allowEval` enforcement point) |
| `src/index.js` | Build context, register tools, connect stdio transport |
| `certs/riotgames.pem` | Vendored Riot root CA |
| `config/allowlist.json` | Default config |
| `scripts/smoke.mjs` | Manual live end-to-end check |
| `tests/*.test.js` | One test file per source module |

Deviation from the spec's sketch, deliberate: allowlist matching lives in `src/allowlist.js` (not inside `config.js`) and ingest policy in `src/lcu/ingest.js`, so both are pure and directly testable. `src/tools/result.js` is added for shared tool-result shapes.

---

### Task 1: Package scaffold and config loader

**Files:**
- Create: `package.json`, `.gitignore` (already present — leave as is), `config/allowlist.json`, `src/config.js`
- Test: `tests/config.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `DEFAULTS` (object), `validateConfig(raw) -> config`, `loadConfig({ env, cwd }) -> { allowEval, cdpPort, eventBufferSize, writeAllowlist, configPath }`. A missing config file is **not** an error — defaults are returned with `configPath` set to the path that was looked for.

- [ ] **Step 1: Create the package manifest**

```json
{
  "name": "lcu-mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "MCP server for the League of Legends client (LCU REST + events + CEF DOM)",
  "engines": { "node": ">=24.0.0" },
  "bin": { "lcu-mcp": "src/index.js" },
  "scripts": {
    "start": "node src/index.js",
    "test": "node --test",
    "smoke": "node scripts/smoke.mjs"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "ws": "^8.18.0",
    "zod": "^3.25.76"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, `package-lock.json` written, no audit failures that block install.

- [ ] **Step 3: Write the default config file**

`config/allowlist.json`:

```json
{
  "allowEval": true,
  "cdpPort": 8888,
  "eventBufferSize": 1000,
  "writeAllowlist": [
    "POST /lol-matchmaking/v1/ready-check/accept",
    "POST /lol-lobby/v2/lobby/matchmaking/search"
  ]
}
```

- [ ] **Step 4: Write the failing test**

`tests/config.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, loadConfig, validateConfig } from '../src/config.js';

function tmpConfig(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'lcu-mcp-'));
  const path = join(dir, 'allowlist.json');
  writeFileSync(path, contents, 'utf8');
  return path;
}

test('missing config file falls back to defaults', () => {
  const config = loadConfig({ env: { LCU_MCP_CONFIG: join(tmpdir(), 'does-not-exist.json') } });
  assert.equal(config.allowEval, DEFAULTS.allowEval);
  assert.equal(config.cdpPort, 8888);
  assert.equal(config.eventBufferSize, 1000);
  assert.deepEqual(config.writeAllowlist, []);
  assert.match(config.configPath, /does-not-exist\.json$/);
});

test('config file values override defaults', () => {
  const path = tmpConfig('{"allowEval": false, "cdpPort": 9222, "writeAllowlist": ["POST /a"]}');
  const config = loadConfig({ env: { LCU_MCP_CONFIG: path } });
  assert.equal(config.allowEval, false);
  assert.equal(config.cdpPort, 9222);
  assert.equal(config.eventBufferSize, 1000);
  assert.deepEqual(config.writeAllowlist, ['POST /a']);
});

test('malformed JSON reports the config path', () => {
  const path = tmpConfig('{ not json');
  assert.throws(() => loadConfig({ env: { LCU_MCP_CONFIG: path } }), (err) => err.message.includes(path));
});

test('validateConfig rejects wrong types', () => {
  assert.throws(() => validateConfig({ cdpPort: 'eight' }), /cdpPort/);
  assert.throws(() => validateConfig({ writeAllowlist: 'POST /a' }), /writeAllowlist/);
  assert.throws(() => validateConfig({ allowEval: 'yes' }), /allowEval/);
  assert.throws(() => validateConfig({ eventBufferSize: 0 }), /eventBufferSize/);
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/config.js'`.

- [ ] **Step 6: Write the implementation**

`src/config.js`:

```js
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const DEFAULTS = {
  allowEval: true,
  cdpPort: 8888,
  eventBufferSize: 1000,
  writeAllowlist: []
};

export function validateConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Config must be a JSON object');
  }
  const config = { ...DEFAULTS, ...raw };
  if (typeof config.allowEval !== 'boolean') {
    throw new Error(`Config "allowEval" must be a boolean, got ${typeof config.allowEval}`);
  }
  if (!Number.isInteger(config.cdpPort) || config.cdpPort < 1 || config.cdpPort > 65535) {
    throw new Error(`Config "cdpPort" must be an integer port, got ${JSON.stringify(config.cdpPort)}`);
  }
  if (!Number.isInteger(config.eventBufferSize) || config.eventBufferSize < 1) {
    throw new Error(`Config "eventBufferSize" must be a positive integer, got ${JSON.stringify(config.eventBufferSize)}`);
  }
  if (!Array.isArray(config.writeAllowlist) || config.writeAllowlist.some((e) => typeof e !== 'string')) {
    throw new Error('Config "writeAllowlist" must be an array of "METHOD /path" strings');
  }
  return config;
}

export function loadConfig({ env = process.env, cwd = process.cwd() } = {}) {
  const configPath = env.LCU_MCP_CONFIG ?? resolve(cwd, 'config/allowlist.json');
  let text;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { ...DEFAULTS, configPath };
    throw new Error(`Cannot read config at ${configPath}: ${err.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`Config at ${configPath} is not valid JSON: ${err.message}`);
  }
  return { ...validateConfig(raw), configPath };
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 4 tests.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json config/allowlist.json src/config.js tests/config.test.js
git commit -m "feat: package scaffold and config loader"
```

---

### Task 2: Write allowlist matching

**Files:**
- Create: `src/allowlist.js`
- Test: `tests/allowlist.test.js`

**Interfaces:**
- Consumes: `writeAllowlist` array from Task 1's config.
- Produces: `checkWrite(method, path, allowlist) -> { allowed: boolean, line: string, message?: string }`. `line` is the exact allowlist entry that would permit the call (`"POST /lol-lobby/v2/lobby"`). `message` is present only when `allowed` is false.

- [ ] **Step 1: Write the failing test**

`tests/allowlist.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkWrite } from '../src/allowlist.js';

const list = [
  'POST /lol-matchmaking/v1/ready-check/accept',
  'POST /lol-champ-select/v1/session/actions/*'
];

test('GET and HEAD are always allowed', () => {
  assert.equal(checkWrite('GET', '/anything', []).allowed, true);
  assert.equal(checkWrite('head', '/anything', []).allowed, true);
});

test('exact entry allows the write', () => {
  assert.equal(checkWrite('POST', '/lol-matchmaking/v1/ready-check/accept', list).allowed, true);
});

test('method comparison is case-insensitive', () => {
  assert.equal(checkWrite('post', '/lol-matchmaking/v1/ready-check/accept', list).allowed, true);
});

test('path comparison is case-sensitive', () => {
  assert.equal(checkWrite('POST', '/LOL-matchmaking/v1/ready-check/accept', list).allowed, false);
});

test('trailing wildcard matches exactly one further segment', () => {
  assert.equal(checkWrite('PATCH', '/lol-champ-select/v1/session/actions/7', list).allowed, false);
  assert.equal(checkWrite('POST', '/lol-champ-select/v1/session/actions/7', list).allowed, true);
  assert.equal(checkWrite('POST', '/lol-champ-select/v1/session/actions/7/extra', list).allowed, false);
  assert.equal(checkWrite('POST', '/lol-champ-select/v1/session/actions/', list).allowed, false);
});

test('denial names the exact line to add', () => {
  const result = checkWrite('POST', '/lol-lobby/v2/lobby', list);
  assert.equal(result.allowed, false);
  assert.equal(result.line, 'POST /lol-lobby/v2/lobby');
  assert.match(result.message, /not on the write allowlist/);
  assert.match(result.message, /"POST \/lol-lobby\/v2\/lobby"/);
  assert.match(result.message, /writeAllowlist/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/allowlist.test.js`
Expected: FAIL — `Cannot find module '../src/allowlist.js'`.

- [ ] **Step 3: Write the implementation**

`src/allowlist.js`:

```js
const ALWAYS_ALLOWED = new Set(['GET', 'HEAD']);

function pathMatches(pattern, path) {
  if (!pattern.endsWith('/*')) return pattern === path;
  const prefix = pattern.slice(0, -1);
  if (!path.startsWith(prefix)) return false;
  const rest = path.slice(prefix.length);
  return rest.length > 0 && !rest.includes('/');
}

export function checkWrite(method, path, allowlist = []) {
  const verb = String(method).toUpperCase();
  const line = `${verb} ${path}`;
  if (ALWAYS_ALLOWED.has(verb)) return { allowed: true, line };

  for (const entry of allowlist) {
    const spaceAt = entry.indexOf(' ');
    if (spaceAt === -1) continue;
    const entryVerb = entry.slice(0, spaceAt).toUpperCase();
    const entryPath = entry.slice(spaceAt + 1).trim();
    if (entryVerb === verb && pathMatches(entryPath, path)) return { allowed: true, line: entry };
  }

  return {
    allowed: false,
    line,
    message:
      `${line} is not on the write allowlist. To permit it, add ` +
      `"${line}" to "writeAllowlist" in the config file.`
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/allowlist.test.js`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/allowlist.js tests/allowlist.test.js
git commit -m "feat: write allowlist matching with paste-ready denial message"
```

---

### Task 3: Credential redaction

**Files:**
- Create: `src/redact.js`
- Test: `tests/redact.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `redactUrl(rawUrl) -> string` (replaces URL userinfo password with `***`, returns the input unchanged if it does not parse), `redactSecrets(text, secrets) -> string` (replaces every occurrence of each non-empty secret with `***`; non-string input is returned unchanged).

- [ ] **Step 1: Write the failing test**

`tests/redact.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, redactUrl } from '../src/redact.js';

const PASSWORD = 'S3cr3t-Pa55';

test('redactUrl strips the password from a CDP target URL', () => {
  const url = `https://riot:${PASSWORD}@127.0.0.1:29669/index.html`;
  const out = redactUrl(url);
  assert.ok(!out.includes(PASSWORD));
  assert.ok(out.includes('riot:***@127.0.0.1:29669'));
});

test('redactUrl leaves password-free URLs recognisable', () => {
  assert.equal(redactUrl('ws://127.0.0.1:8888/devtools/page/ABC'), 'ws://127.0.0.1:8888/devtools/page/ABC');
});

test('redactUrl returns non-URL input unchanged', () => {
  assert.equal(redactUrl('not a url'), 'not a url');
});

test('redactSecrets removes every occurrence', () => {
  const text = `connect wss://riot:${PASSWORD}@127.0.0.1:1 failed for ${PASSWORD}`;
  const out = redactSecrets(text, [PASSWORD]);
  assert.ok(!out.includes(PASSWORD));
  assert.equal(out.split('***').length - 1, 2);
});

test('redactSecrets ignores empty and non-string secrets', () => {
  assert.equal(redactSecrets('abc', ['', null, undefined]), 'abc');
  assert.equal(redactSecrets(undefined, [PASSWORD]), undefined);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/redact.test.js`
Expected: FAIL — `Cannot find module '../src/redact.js'`.

- [ ] **Step 3: Write the implementation**

`src/redact.js`:

```js
export function redactUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return rawUrl;
  const schemeEnd = rawUrl.indexOf('://');
  if (schemeEnd === -1) return rawUrl;
  const authorityStart = schemeEnd + 3;
  const slash = rawUrl.indexOf('/', authorityStart);
  const authorityEnd = slash === -1 ? rawUrl.length : slash;
  const at = rawUrl.lastIndexOf('@', authorityEnd - 1);
  if (at < authorityStart) return rawUrl;
  const colon = rawUrl.indexOf(':', authorityStart);
  if (colon === -1 || colon > at) return rawUrl; // userinfo carries no password
  return `${rawUrl.slice(0, colon + 1)}***${rawUrl.slice(at)}`;
}

export function redactSecrets(text, secrets = []) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length === 0) continue;
    out = out.split(secret).join('***');
  }
  return out;
}
```

Slicing the raw string rather than going through `URL` is deliberate, and stricter than it first looks. `URL.toString()` percent-encodes and normalises, which would change paths the caller may want to compare — but `URL.password` is no safer as a *search key*: it too returns the percent-encoded form, so `rawUrl.replace(':' + parsed.password + '@', ':***@')` silently misses whenever the password holds a character from the userinfo encode set (space, `@`, `\`, `^`, `|`, `"`, non-ASCII…) and returns the credential in full cleartext. Slicing also never builds a regex out of the secret. The authority runs to the first `/` and the split point is its **last** `@`, so a password containing `@`, `?`, or regex metacharacters is still redacted whole.

Add a test covering that class explicitly — passwords such as `'a b'`, `'a@b'`, `'a.b*c+d?e(f)[g]$h'`, `'p^ss|w"rd'`, `'senña'` must all come back as `https://riot:***@127.0.0.1:29669/index.html` — plus non-string input (`undefined`, `null`, a number) returned unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/redact.test.js`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/redact.js tests/redact.test.js
git commit -m "feat: credential redaction helpers"
```

---

### Task 4: Lockfile parsing, reading, and directory watching

**Files:**
- Create: `src/lcu/lockfile.js`
- Test: `tests/lockfile.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `DEFAULT_LOCKFILE_PATH` (string), `parseLockfile(text) -> { name, pid, port, password, protocol }` (throws on malformed input), `readCredentials(path) -> Promise<credentials>` (throws a "client is not running" error on ENOENT), `watchLockfileDir(path, onChange) -> stop()` (watches the **directory**, fires `onChange()` for create/change/delete of the lockfile itself).

- [ ] **Step 1: Write the failing test**

`tests/lockfile.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLockfile, readCredentials, watchLockfileDir } from '../src/lcu/lockfile.js';

const VALID = 'LeagueClient:26340:29669:tS8mFOfKZ-KpiUAZjs4pXQ:https';

test('parses a valid lockfile', () => {
  const creds = parseLockfile(VALID);
  assert.deepEqual(creds, {
    name: 'LeagueClient',
    pid: 26340,
    port: 29669,
    password: 'tS8mFOfKZ-KpiUAZjs4pXQ',
    protocol: 'https'
  });
});

test('tolerates a trailing newline', () => {
  assert.equal(parseLockfile(`${VALID}\n`).port, 29669);
});

test('rejects the wrong field count', () => {
  assert.throws(() => parseLockfile('LeagueClient:26340:29669'), /5 colon-separated fields/);
});

test('rejects a non-numeric port', () => {
  assert.throws(() => parseLockfile('LeagueClient:26340:abc:pw:https'), /port/);
});

test('rejects an empty file', () => {
  assert.throws(() => parseLockfile(''), /empty/);
});

test('readCredentials reports a missing lockfile as a stopped client', async () => {
  const path = join(tmpdir(), 'lcu-mcp-absent', 'lockfile');
  await assert.rejects(readCredentials(path), /not running/);
});

test('readCredentials reads a real file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lcu-mcp-'));
  const path = join(dir, 'lockfile');
  writeFileSync(path, VALID, 'utf8');
  assert.equal((await readCredentials(path)).port, 29669);
});

test('watchLockfileDir fires when the lockfile is recreated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lcu-mcp-'));
  const path = join(dir, 'lockfile');
  writeFileSync(path, VALID, 'utf8');

  const fired = new Promise((resolve) => {
    const stop = watchLockfileDir(path, () => {
      stop();
      resolve(true);
    });
    setTimeout(() => {
      rmSync(path);
      writeFileSync(path, VALID.replace('29669', '1527'), 'utf8');
    }, 50);
  });

  assert.equal(await fired, true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/lockfile.test.js`
Expected: FAIL — `Cannot find module '../src/lcu/lockfile.js'`.

- [ ] **Step 3: Write the implementation**

`src/lcu/lockfile.js`:

```js
import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

export const DEFAULT_LOCKFILE_PATH = 'C:\\Riot Games\\League of Legends\\lockfile';

export function parseLockfile(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed.length === 0) throw new Error('Lockfile is empty');
  const parts = trimmed.split(':');
  if (parts.length !== 5) {
    throw new Error(`Malformed lockfile: expected 5 colon-separated fields, got ${parts.length}`);
  }
  const [name, pid, port, password, protocol] = parts;
  if (!/^\d+$/.test(port)) throw new Error(`Malformed lockfile: port "${port}" is not a number`);
  if (!/^\d+$/.test(pid)) throw new Error(`Malformed lockfile: pid "${pid}" is not a number`);
  return { name, pid: Number(pid), port: Number(port), password, protocol };
}

export async function readCredentials(path = DEFAULT_LOCKFILE_PATH) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`League client is not running: no lockfile at ${path}`);
    }
    throw new Error(`Cannot read lockfile at ${path}: ${err.message}`);
  }
  return parseLockfile(text);
}

export function watchLockfileDir(path = DEFAULT_LOCKFILE_PATH, onChange = () => {}) {
  const dir = dirname(path);
  const file = basename(path);
  const watcher = watch(dir, (_eventType, filename) => {
    if (filename === null || filename === file) onChange();
  });
  watcher.on('error', () => {});
  return () => watcher.close();
}
```

The lockfile is deleted and recreated on restart, so watching the file itself would keep a handle on a dead inode — the directory is watched instead. `filename === null` is treated as a hit because some platforms omit it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/lockfile.test.js`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lcu/lockfile.js tests/lockfile.test.js
git commit -m "feat: lockfile parsing and directory watching"
```

---

### Task 5: Vendored Riot CA and the LCU REST client

**Files:**
- Create: `certs/riotgames.pem`, `src/lcu/client.js`
- Test: `tests/lcu-client.test.js`

**Interfaces:**
- Consumes: `readCredentials`, `watchLockfileDir`, `DEFAULT_LOCKFILE_PATH` (Task 4).
- Produces:
  - `buildAuthHeader(password) -> "Basic <base64>"`
  - `buildRequestOptions({ creds, method, path, body, ca }) -> { options, payload }` where `options` is a `https.request` options object and `payload` is a JSON string or `undefined`
  - `class LcuClient` with `credentials() -> Promise<creds>`, `request(method, path, body) -> Promise<{ status, body }>`, `get(path)`, `invalidate()`, `statusSnapshot() -> { connected, port, lastError }`, `close()`
  - `LcuClient` constructor: `new LcuClient({ lockfilePath, caPath })`

`request()` never enforces the write allowlist — that is the tool layer's job (Task 13).

- [ ] **Step 1: Vendor Riot's root CA**

Run:

```bash
mkdir -p certs
curl -fsSL https://static.developer.riotgames.com/docs/lol/riotgames.pem -o certs/riotgames.pem
openssl x509 -in certs/riotgames.pem -noout -subject
```

Expected: the subject contains `LoL Game Engineering Certificate Authority`. If the download fails, the same PEM ships inside the client install; do **not** proceed by disabling verification.

- [ ] **Step 2: Write the failing test**

`tests/lcu-client.test.js`. The test exercises the pure builders plus a real HTTPS round-trip against a throwaway self-signed server, with that server's own cert passed as the pinned CA — this proves verification is genuinely on (a wrong CA must fail).

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAuthHeader, buildRequestOptions } from '../src/lcu/client.js';

test('buildAuthHeader uses the riot username', () => {
  assert.equal(buildAuthHeader('pw'), `Basic ${Buffer.from('riot:pw').toString('base64')}`);
});

test('buildRequestOptions targets 127.0.0.1 with auth and JSON body', () => {
  const ca = readFileSync('certs/riotgames.pem');
  const { options, payload } = buildRequestOptions({
    creds: { port: 29669, password: 'pw' },
    method: 'post',
    path: '/lol-lobby/v2/lobby',
    body: { queueId: 430 },
    ca
  });

  assert.equal(options.hostname, '127.0.0.1');
  assert.equal(options.port, 29669);
  assert.equal(options.method, 'POST');
  assert.equal(options.path, '/lol-lobby/v2/lobby');
  assert.equal(options.headers.Authorization, buildAuthHeader('pw'));
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.equal(options.headers['Content-Length'], Buffer.byteLength('{"queueId":430}'));
  assert.equal(payload, '{"queueId":430}');
  assert.equal(options.ca, ca);
  assert.equal(options.rejectUnauthorized, undefined, 'must never opt out of verification');
});

test('buildRequestOptions omits body headers for GET', () => {
  const { options, payload } = buildRequestOptions({
    creds: { port: 1527, password: 'pw' },
    method: 'GET',
    path: '/lol-gameflow/v1/gameflow-phase'
  });
  assert.equal(payload, undefined);
  assert.equal(options.headers['Content-Type'], undefined);
});

test('buildRequestOptions rejects a path without a leading slash', () => {
  assert.throws(
    () => buildRequestOptions({ creds: { port: 1, password: 'p' }, method: 'GET', path: 'lol-summoner/v1' }),
    /must start with "\/"/
  );
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test tests/lcu-client.test.js`
Expected: FAIL — `Cannot find module '../src/lcu/client.js'`.

- [ ] **Step 4: Write the implementation**

`src/lcu/client.js`:

```js
import { readFileSync } from 'node:fs';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { DEFAULT_LOCKFILE_PATH, readCredentials, watchLockfileDir } from './lockfile.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CA_PATH = resolve(HERE, '../../certs/riotgames.pem');

export function buildAuthHeader(password) {
  return `Basic ${Buffer.from(`riot:${password}`).toString('base64')}`;
}

export function buildRequestOptions({ creds, method, path, body, ca }) {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new Error(`LCU path must start with "/", got ${JSON.stringify(path)}`);
  }
  const headers = {
    Authorization: buildAuthHeader(creds.password),
    Accept: 'application/json'
  };
  let payload;
  if (body !== undefined && body !== null) {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  return {
    options: { hostname: '127.0.0.1', port: creds.port, method: String(method).toUpperCase(), path, headers, ca },
    payload
  };
}

export class LcuClient {
  #creds = null;
  #lastError = null;
  #stopWatch = null;

  constructor({ lockfilePath = DEFAULT_LOCKFILE_PATH, caPath = DEFAULT_CA_PATH } = {}) {
    this.lockfilePath = lockfilePath;
    this.ca = readFileSync(caPath);
    this.agent = new https.Agent({ ca: this.ca, keepAlive: true });
  }

  async credentials() {
    if (this.#creds) return this.#creds;
    this.#stopWatch ??= watchLockfileDir(this.lockfilePath, () => this.invalidate());
    try {
      this.#creds = await readCredentials(this.lockfilePath);
      this.#lastError = null;
    } catch (err) {
      this.#lastError = err.message;
      throw err;
    }
    return this.#creds;
  }

  invalidate() {
    this.#creds = null;
  }

  async request(method, path, body, { retry = true } = {}) {
    const creds = await this.credentials();
    try {
      return await this.#send(creds, method, path, body);
    } catch (err) {
      // A stale port survives in the cache when the client restarts between calls.
      if (retry && (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET')) {
        this.invalidate();
        return this.request(method, path, body, { retry: false });
      }
      this.#lastError = err.message;
      throw new Error(`LCU request ${String(method).toUpperCase()} ${path} failed: ${err.message}`);
    }
  }

  get(path) {
    return this.request('GET', path);
  }

  #send(creds, method, path, body) {
    const { options, payload } = buildRequestOptions({ creds, method, path, body, ca: this.ca });
    return new Promise((resolvePromise, reject) => {
      const req = https.request({ ...options, agent: this.agent }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = text;
          if (text.length > 0) {
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = text;
            }
          }
          resolvePromise({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  statusSnapshot() {
    return {
      connected: this.#creds !== null,
      port: this.#creds?.port ?? null,
      lockfilePath: this.lockfilePath,
      lastError: this.#lastError
    };
  }

  close() {
    this.#stopWatch?.();
    this.#stopWatch = null;
    this.agent.destroy();
  }
}
```

`statusSnapshot()` returns the port but never the password.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/lcu-client.test.js`
Expected: PASS — 4 tests.

- [ ] **Step 6: Verify against the live client (requires League running)**

Run: `node -e "import('./src/lcu/client.js').then(async ({LcuClient}) => { const c = new LcuClient(); console.log(await c.get('/lol-gameflow/v1/gameflow-phase')); c.close(); })"`
Expected: `{ status: 200, body: 'None' }` (or another phase string). A TLS error here means the vendored PEM is wrong — fix the PEM, never the verification setting. If League is not running, skip this step and note it.

- [ ] **Step 7: Commit**

```bash
git add certs/riotgames.pem src/lcu/client.js tests/lcu-client.test.js
git commit -m "feat: LCU REST client with pinned Riot root CA"
```

---

### Task 6: Event ring buffer

**Files:**
- Create: `src/lcu/buffer.js`
- Test: `tests/buffer.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `class RingBuffer` — `new RingBuffer(size = 1000)`, `push({ eventType, uri, data, truncated }) -> entry` (assigns `seq` starting at 1 and `ts`), `since(seq = 0, limit = 100, filter = null) -> { entries, cursor, dropped, remaining }`, `clear()`, `get length`.

`dropped` is the number of entries that were evicted after the caller's `since` cursor — the signal that the stream has a gap. `filter` is a URI prefix applied at poll time (ingest-time filtering is Task 8).

- [ ] **Step 1: Write the failing test**

`tests/buffer.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RingBuffer } from '../src/lcu/buffer.js';

function fill(buffer, count, uri = '/lol-gameflow/v1/session') {
  for (let i = 0; i < count; i += 1) buffer.push({ eventType: 'Update', uri, data: i });
}

test('push assigns increasing seq numbers starting at 1', () => {
  const buffer = new RingBuffer(10);
  assert.equal(buffer.push({ uri: '/a' }).seq, 1);
  assert.equal(buffer.push({ uri: '/a' }).seq, 2);
  assert.ok(typeof buffer.push({ uri: '/a' }).ts === 'number');
});

test('oldest entries are evicted on overflow', () => {
  const buffer = new RingBuffer(3);
  fill(buffer, 5);
  assert.equal(buffer.length, 3);
  const { entries } = buffer.since(0, 100);
  assert.deepEqual(entries.map((e) => e.seq), [3, 4, 5]);
});

test('since returns only entries after the cursor', () => {
  const buffer = new RingBuffer(10);
  fill(buffer, 5);
  const { entries, cursor } = buffer.since(3, 100);
  assert.deepEqual(entries.map((e) => e.seq), [4, 5]);
  assert.equal(cursor, 5);
});

test('dropped counts entries evicted past the cursor', () => {
  const buffer = new RingBuffer(3);
  fill(buffer, 10);
  const { dropped, entries } = buffer.since(2, 100);
  assert.equal(dropped, 5); // seq 3..7 evicted, oldest retained is 8
  assert.deepEqual(entries.map((e) => e.seq), [8, 9, 10]);
});

test('dropped is zero when nothing was evicted past the cursor', () => {
  const buffer = new RingBuffer(10);
  fill(buffer, 4);
  assert.equal(buffer.since(4, 100).dropped, 0);
});

test('limit caps the page and remaining reports the rest', () => {
  const buffer = new RingBuffer(10);
  fill(buffer, 6);
  const { entries, cursor, remaining } = buffer.since(0, 2);
  assert.deepEqual(entries.map((e) => e.seq), [1, 2]);
  assert.equal(cursor, 2);
  assert.equal(remaining, 4);
});

test('an empty result keeps the caller cursor', () => {
  const buffer = new RingBuffer(10);
  fill(buffer, 3);
  assert.equal(buffer.since(3, 100).cursor, 3);
  assert.equal(new RingBuffer(10).since(0, 100).cursor, 0);
});

test('filter applies a URI prefix at poll time', () => {
  const buffer = new RingBuffer(10);
  fill(buffer, 2, '/lol-champ-select/v1/session');
  fill(buffer, 2, '/lol-gameflow/v1/session');
  const { entries } = buffer.since(0, 100, '/lol-champ-select/');
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.uri.startsWith('/lol-champ-select/')));
});

test('clear empties the buffer but not the seq counter', () => {
  const buffer = new RingBuffer(10);
  fill(buffer, 3);
  buffer.clear();
  assert.equal(buffer.length, 0);
  assert.equal(buffer.push({ uri: '/a' }).seq, 4);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/buffer.test.js`
Expected: FAIL — `Cannot find module '../src/lcu/buffer.js'`.

- [ ] **Step 3: Write the implementation**

`src/lcu/buffer.js`:

```js
export class RingBuffer {
  #entries = [];
  #nextSeq = 1;

  constructor(size = 1000) {
    if (!Number.isInteger(size) || size < 1) throw new Error(`RingBuffer size must be a positive integer, got ${size}`);
    this.size = size;
  }

  get length() {
    return this.#entries.length;
  }

  push(entry) {
    const stored = { seq: this.#nextSeq, ts: Date.now(), ...entry };
    this.#nextSeq += 1;
    this.#entries.push(stored);
    if (this.#entries.length > this.size) this.#entries.splice(0, this.#entries.length - this.size);
    return stored;
  }

  since(seq = 0, limit = 100, filter = null) {
    const oldestSeq = this.#entries.length > 0 ? this.#entries[0].seq : this.#nextSeq;
    const dropped = Math.max(0, oldestSeq - 1 - seq);
    let matching = this.#entries.filter((e) => e.seq > seq);
    if (filter) matching = matching.filter((e) => typeof e.uri === 'string' && e.uri.startsWith(filter));
    const entries = matching.slice(0, limit);
    const cursor = entries.length > 0 ? entries[entries.length - 1].seq : seq;
    return { entries, cursor, dropped, remaining: matching.length - entries.length };
  }

  clear() {
    this.#entries = [];
  }
}
```

Note the cursor rule: an empty page returns the caller's own `seq` so a poll loop never rewinds or skips. When a page is filtered, the cursor advances only to the last **returned** entry, so entries excluded by the filter are re-scanned on the next poll — correct, because filters can change between polls.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/buffer.test.js`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lcu/buffer.js tests/buffer.test.js
git commit -m "feat: event ring buffer with cursor and dropped accounting"
```

---

### Task 7: Ingest policy — filters and truncation

**Files:**
- Create: `src/lcu/ingest.js`
- Test: `tests/ingest.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `MAX_DATA_BYTES` (4096), `matchesFilters(uri, filters) -> boolean` (empty or absent filters match everything), `truncateData(data, max = MAX_DATA_BYTES) -> { data, truncated }`, `decodeFrame(raw) -> { eventType, uri, data } | null` (returns `null` for empty frames, non-JSON, and any frame that is not `[8, "OnJsonApiEvent", payload]`).

- [ ] **Step 1: Write the failing test**

`tests/ingest.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_DATA_BYTES, decodeFrame, matchesFilters, truncateData } from '../src/lcu/ingest.js';

test('absent or empty filters match every uri', () => {
  assert.equal(matchesFilters('/lol-gameflow/v1/session', []), true);
  assert.equal(matchesFilters('/lol-gameflow/v1/session', undefined), true);
});

test('filters match on uri prefix', () => {
  const filters = ['/lol-champ-select/', '/lol-matchmaking/'];
  assert.equal(matchesFilters('/lol-champ-select/v1/session', filters), true);
  assert.equal(matchesFilters('/lol-gameflow/v1/session', filters), false);
});

test('small data is not truncated', () => {
  const result = truncateData({ phase: 'ReadyCheck' });
  assert.deepEqual(result, { data: { phase: 'ReadyCheck' }, truncated: false });
});

test('oversized data becomes a truncated JSON string', () => {
  const big = { blob: 'x'.repeat(MAX_DATA_BYTES * 2) };
  const result = truncateData(big);
  assert.equal(result.truncated, true);
  assert.equal(typeof result.data, 'string');
  assert.equal(result.data.length, MAX_DATA_BYTES);
});

test('null and undefined data pass through', () => {
  assert.deepEqual(truncateData(null), { data: null, truncated: false });
  assert.deepEqual(truncateData(undefined), { data: undefined, truncated: false });
});

test('decodeFrame reads an OnJsonApiEvent frame', () => {
  const raw = JSON.stringify([8, 'OnJsonApiEvent', { eventType: 'Update', uri: '/lol-gameflow/v1/session', data: { phase: 'Lobby' } }]);
  assert.deepEqual(decodeFrame(raw), {
    eventType: 'Update',
    uri: '/lol-gameflow/v1/session',
    data: { phase: 'Lobby' }
  });
});

test('decodeFrame returns null for the empty subscribe ack', () => {
  assert.equal(decodeFrame(''), null);
  assert.equal(decodeFrame('   '), null);
  assert.equal(decodeFrame(Buffer.alloc(0)), null);
});

test('decodeFrame returns null for junk and non-event frames', () => {
  assert.equal(decodeFrame('not json'), null);
  assert.equal(decodeFrame(JSON.stringify([5, 'OnJsonApiEvent'])), null);
  assert.equal(decodeFrame(JSON.stringify({ eventType: 'Update' })), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/ingest.test.js`
Expected: FAIL — `Cannot find module '../src/lcu/ingest.js'`.

- [ ] **Step 3: Write the implementation**

`src/lcu/ingest.js`:

```js
export const MAX_DATA_BYTES = 4096;

export function matchesFilters(uri, filters) {
  if (!Array.isArray(filters) || filters.length === 0) return true;
  return filters.some((prefix) => typeof uri === 'string' && uri.startsWith(prefix));
}

export function truncateData(data, max = MAX_DATA_BYTES) {
  if (data === undefined || data === null) return { data, truncated: false };
  const json = JSON.stringify(data);
  if (json === undefined || json.length <= max) return { data, truncated: false };
  return { data: json.slice(0, max), truncated: true };
}

// The subscribe ack arrives as an empty frame; parsing it as JSON throws.
export function decodeFrame(raw) {
  const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
  if (text.trim().length === 0) return null;
  let frame;
  try {
    frame = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(frame) || frame[0] !== 8 || frame[1] !== 'OnJsonApiEvent') return null;
  const payload = frame[2];
  if (payload === null || typeof payload !== 'object') return null;
  return { eventType: payload.eventType, uri: payload.uri, data: payload.data };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/ingest.test.js`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lcu/ingest.js tests/ingest.test.js
git commit -m "feat: event ingest policy - prefix filters, truncation, frame decoding"
```

---

### Task 8: WSS event tap with reconnect

**Files:**
- Create: `src/lcu/events.js`
- Test: `tests/events-tap.test.js`

**Interfaces:**
- Consumes: `LcuClient` (Task 5, for `credentials()`), `RingBuffer` (Task 6), `decodeFrame`/`matchesFilters`/`truncateData` (Task 7).
- Produces:
  - `backoffDelay(attempt) -> ms` — 1000 ms doubling, capped at 30000 ms
  - `RECONNECT_URI` = `'/__lcu_mcp__/reconnected'`
  - `class LcuEventTap` — `new LcuEventTap({ client, buffer, wsFactory, delay })`, `start(filters = []) -> Promise<void>`, `stop()`, `statusSnapshot() -> { running, filters, attempts, lastError }`
- `wsFactory({ url, ca })` is injected so tests can supply a fake socket; the default creates a `ws` `WebSocket`. `delay(ms) -> Promise` is injected so tests do not wait real seconds.

Behaviour requirements from the spec: subscribe with `[5,"OnJsonApiEvent"]`; skip empty frames; apply filters **at ingest**; `start()` while already running replaces the filters and keeps the buffer; on unexpected close, reconnect with backoff and push a marker entry so the gap is visible.

- [ ] **Step 1: Write the failing test**

`tests/events-tap.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RingBuffer } from '../src/lcu/buffer.js';
import { LcuEventTap, RECONNECT_URI, backoffDelay } from '../src/lcu/events.js';

class FakeSocket extends EventEmitter {
  sent = [];
  closed = false;
  send(data) { this.sent.push(data); }
  close() { this.closed = true; this.emit('close', 1000); }
  terminate() { this.closed = true; }
}

function harness({ filters = [] } = {}) {
  const sockets = [];
  const buffer = new RingBuffer(100);
  const tap = new LcuEventTap({
    client: { credentials: async () => ({ port: 29669, password: 'pw' }) },
    buffer,
    wsFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    delay: async () => {}
  });
  return { tap, buffer, sockets, filters };
}

function frame(uri, data = { ok: true }, eventType = 'Update') {
  return JSON.stringify([8, 'OnJsonApiEvent', { eventType, uri, data }]);
}

test('backoffDelay doubles from 1s and caps at 30s', () => {
  assert.equal(backoffDelay(0), 1000);
  assert.equal(backoffDelay(1), 2000);
  assert.equal(backoffDelay(4), 16000);
  assert.equal(backoffDelay(5), 30000);
  assert.equal(backoffDelay(50), 30000);
});

test('start subscribes to OnJsonApiEvent', async () => {
  const { tap, sockets } = harness();
  const started = tap.start();
  sockets[0].emit('open');
  await started;
  assert.deepEqual(JSON.parse(sockets[0].sent[0]), [5, 'OnJsonApiEvent']);
  tap.stop();
});

test('events land in the buffer and the empty ack is skipped', async () => {
  const { tap, buffer, sockets } = harness();
  const started = tap.start();
  sockets[0].emit('open');
  await started;
  sockets[0].emit('message', Buffer.alloc(0));
  sockets[0].emit('message', frame('/lol-gameflow/v1/session'));
  assert.equal(buffer.length, 1);
  assert.equal(buffer.since(0, 10).entries[0].uri, '/lol-gameflow/v1/session');
  tap.stop();
});

test('filters are applied at ingest', async () => {
  const { tap, buffer, sockets } = harness();
  const started = tap.start(['/lol-champ-select/']);
  sockets[0].emit('open');
  await started;
  sockets[0].emit('message', frame('/lol-gameflow/v1/session'));
  sockets[0].emit('message', frame('/lol-champ-select/v1/session'));
  assert.equal(buffer.length, 1);
  tap.stop();
});

test('oversized data is stored truncated', async () => {
  const { tap, buffer, sockets } = harness();
  const started = tap.start();
  sockets[0].emit('open');
  await started;
  sockets[0].emit('message', frame('/lol-loot/v1/player-loot', { blob: 'x'.repeat(20000) }));
  const [entry] = buffer.since(0, 10).entries;
  assert.equal(entry.truncated, true);
  tap.stop();
});

test('restarting replaces filters and keeps the buffer', async () => {
  const { tap, buffer, sockets } = harness();
  let started = tap.start(['/lol-gameflow/']);
  sockets[0].emit('open');
  await started;
  sockets[0].emit('message', frame('/lol-gameflow/v1/session'));

  started = tap.start(['/lol-champ-select/']);
  await started;
  assert.equal(buffer.length, 1, 'buffer survives a restart');
  assert.deepEqual(tap.statusSnapshot().filters, ['/lol-champ-select/']);

  const socket = sockets[sockets.length - 1];
  socket.emit('message', frame('/lol-gameflow/v1/session'));
  assert.equal(buffer.length, 1, 'old filter no longer matches');
  socket.emit('message', frame('/lol-champ-select/v1/session'));
  assert.equal(buffer.length, 2);
  tap.stop();
});

test('an unexpected close reconnects and marks the gap', async () => {
  const { tap, buffer, sockets } = harness();
  const started = tap.start();
  sockets[0].emit('open');
  await started;

  sockets[0].emit('close', 1006);
  await new Promise((r) => setImmediate(r));
  sockets[1].emit('open');
  await new Promise((r) => setImmediate(r));

  assert.equal(sockets.length, 2, 'a new socket was opened');
  const marker = buffer.since(0, 10).entries.find((e) => e.uri === RECONNECT_URI);
  assert.ok(marker, 'a reconnect marker was pushed');
  assert.equal(marker.eventType, 'Reconnected');
  tap.stop();
});

test('stop prevents further reconnects', async () => {
  const { tap, sockets } = harness();
  const started = tap.start();
  sockets[0].emit('open');
  await started;
  tap.stop();
  await new Promise((r) => setImmediate(r));
  assert.equal(sockets.length, 1);
  assert.equal(tap.statusSnapshot().running, false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/events-tap.test.js`
Expected: FAIL — `Cannot find module '../src/lcu/events.js'`.

- [ ] **Step 3: Write the implementation**

`src/lcu/events.js`:

```js
import { WebSocket } from 'ws';
import { decodeFrame, matchesFilters, truncateData } from './ingest.js';

export const RECONNECT_URI = '/__lcu_mcp__/reconnected';
const SUBSCRIBE_FRAME = JSON.stringify([5, 'OnJsonApiEvent']);

export function backoffDelay(attempt) {
  return Math.min(30000, 1000 * 2 ** attempt);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class LcuEventTap {
  #socket = null;
  #running = false;
  #attempts = 0;
  #lastError = null;
  #filters = [];

  constructor({ client, buffer, wsFactory, delay = sleep }) {
    this.client = client;
    this.buffer = buffer;
    this.delay = delay;
    this.wsFactory =
      wsFactory ??
      (({ url, ca }) => new WebSocket(url, { ca, headers: { 'Content-Type': 'application/json' } }));
  }

  async start(filters = []) {
    this.#filters = Array.isArray(filters) ? [...filters] : [];
    if (this.#running) return; // filters replaced, buffer and socket kept
    this.#running = true;
    this.#attempts = 0;
    await this.#connect();
  }

  async #connect() {
    const creds = await this.client.credentials();
    // The password-in-URL form is the one verified against the live client.
    // Never log this URL.
    const url = `wss://riot:${creds.password}@127.0.0.1:${creds.port}/`;
    const socket = this.wsFactory({ url, ca: this.client.ca });
    this.#socket = socket;

    socket.on('message', (raw) => this.#ingest(raw));
    socket.on('error', (err) => {
      this.#lastError = `event socket error: ${err?.code ?? err?.message ?? 'unknown'}`;
    });
    socket.on('close', () => {
      if (this.#socket === socket) this.#socket = null;
      if (this.#running) this.#scheduleReconnect();
    });

    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    socket.send(SUBSCRIBE_FRAME);
    this.#attempts = 0;
  }

  async #scheduleReconnect() {
    const attempt = this.#attempts;
    this.#attempts += 1;
    await this.delay(backoffDelay(attempt));
    if (!this.#running) return;
    this.client.invalidate?.(); // the port may have changed with the restart
    try {
      await this.#connect();
      this.buffer.push({
        eventType: 'Reconnected',
        uri: RECONNECT_URI,
        data: { attempt: attempt + 1 },
        truncated: false
      });
    } catch (err) {
      this.#lastError = `reconnect failed: ${err.message}`;
      if (this.#running) this.#scheduleReconnect();
    }
  }

  #ingest(raw) {
    const event = decodeFrame(raw);
    if (event === null) return;
    if (!matchesFilters(event.uri, this.#filters)) return;
    const { data, truncated } = truncateData(event.data);
    this.buffer.push({ eventType: event.eventType, uri: event.uri, data, truncated });
  }

  stop() {
    this.#running = false;
    const socket = this.#socket;
    this.#socket = null;
    socket?.close();
  }

  statusSnapshot() {
    return {
      running: this.#running,
      connected: this.#socket !== null,
      filters: [...this.#filters],
      attempts: this.#attempts,
      buffered: this.buffer.length,
      lastError: this.#lastError
    };
  }
}
```

The reconnect marker is pushed **after** a successful reconnect, so the buffer never fills with markers while the client is down.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/events-tap.test.js`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lcu/events.js tests/events-tap.test.js
git commit -m "feat: LCU event tap with ingest filters and backoff reconnect"
```

---

### Task 9: CDP discovery with target redaction

**Files:**
- Create: `src/cdp/discover.js`
- Test: `tests/cdp-discover.test.js`

**Interfaces:**
- Consumes: `redactUrl` (Task 3).
- Produces:
  - `class CdpUnavailableError extends Error` (has `port`)
  - `penguHint(port) -> string` — the fix instructions
  - `redactTarget(target) -> target` — `url` and `faviconUrl` redacted, everything else preserved
  - `probeVersion(port) -> Promise<{ Browser, 'Protocol-Version', ... }>`
  - `findPageTarget(port) -> Promise<{ id, title, url, webSocketDebuggerUrl }>` — `url` already redacted; throws `CdpUnavailableError` when the port refuses a connection or no `page` target exists

The socket URL (`webSocketDebuggerUrl`) is `ws://127.0.0.1:<port>/devtools/page/<id>` and contains no secret — it is returned as-is. Only `url` embeds the LCU password.

- [ ] **Step 1: Write the failing test**

`tests/cdp-discover.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { CdpUnavailableError, findPageTarget, probeVersion, redactTarget } from '../src/cdp/discover.js';

const PASSWORD = 'S3cr3t-Pa55';

function stubCdp(routes) {
  const server = createServer((req, res) => {
    const body = routes[req.url];
    if (body === undefined) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => server.close() }));
  });
}

const PAGE_TARGET = {
  id: 'ABC123',
  type: 'page',
  title: 'League Client',
  url: `https://riot:${PASSWORD}@127.0.0.1:29669/index.html`,
  webSocketDebuggerUrl: 'ws://127.0.0.1:8888/devtools/page/ABC123'
};

test('redactTarget strips the password from the target url', () => {
  const out = redactTarget(PAGE_TARGET);
  assert.ok(!JSON.stringify(out).includes(PASSWORD));
  assert.equal(out.webSocketDebuggerUrl, PAGE_TARGET.webSocketDebuggerUrl);
  assert.equal(out.id, 'ABC123');
});

test('probeVersion returns the CEF version payload', async () => {
  const server = await stubCdp({ '/json/version': { Browser: 'Chrome/108.0.0.0', 'Protocol-Version': '1.3' } });
  try {
    const version = await probeVersion(server.port);
    assert.equal(version['Protocol-Version'], '1.3');
  } finally {
    server.close();
  }
});

test('findPageTarget selects the page target and redacts it', async () => {
  const server = await stubCdp({
    '/json/version': { Browser: 'Chrome/108.0.0.0' },
    '/json/list': [{ id: 'OTHER', type: 'other', url: 'about:blank' }, PAGE_TARGET]
  });
  try {
    const target = await findPageTarget(server.port);
    assert.equal(target.id, 'ABC123');
    assert.ok(!target.url.includes(PASSWORD));
  } finally {
    server.close();
  }
});

test('a closed port yields the Pengu hint, not ECONNREFUSED', async () => {
  const server = await stubCdp({});
  const port = server.port;
  server.close();
  await new Promise((r) => setTimeout(r, 20));

  await assert.rejects(findPageTarget(port), (err) => {
    assert.ok(err instanceof CdpUnavailableError);
    assert.match(err.message, /Pengu Loader not active or RemoteDebuggingPort unset/);
    assert.match(err.message, /kill-and-restart-ux/);
    assert.ok(err.message.startsWith('CDP unavailable on port'), 'the fix leads, the socket code is only a detail');
    return true;
  });
});

test('no page target yields a distinct explanation', async () => {
  const server = await stubCdp({ '/json/version': { Browser: 'x' }, '/json/list': [{ id: 'X', type: 'other' }] });
  try {
    await assert.rejects(findPageTarget(server.port), /no "page" target/);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/cdp-discover.test.js`
Expected: FAIL — `Cannot find module '../src/cdp/discover.js'`.

- [ ] **Step 3: Write the implementation**

`src/cdp/discover.js`:

```js
import { redactUrl } from '../redact.js';

export class CdpUnavailableError extends Error {
  constructor(port, detail) {
    super(
      `CDP unavailable on port ${port}: Pengu Loader not active or RemoteDebuggingPort unset. ` +
        `${penguHint(port)}${detail ? ` (${detail})` : ''}`
    );
    this.name = 'CdpUnavailableError';
    this.port = port;
  }
}

export function penguHint(port) {
  return (
    `Set RemoteDebuggingPort=${port} in "C:\\Program Files\\Pengu Loader\\config" ` +
    '(plain key=value text, one pair per line), then restart the UX with ' +
    'POST /riotclient/kill-and-restart-ux.'
  );
}

async function getJson(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response.json();
}

export function redactTarget(target) {
  const out = { ...target };
  if (typeof out.url === 'string') out.url = redactUrl(out.url);
  if (typeof out.faviconUrl === 'string') out.faviconUrl = redactUrl(out.faviconUrl);
  return out;
}

export async function probeVersion(port) {
  try {
    return await getJson(port, '/json/version');
  } catch (err) {
    throw new CdpUnavailableError(port, err.cause?.code ?? err.message);
  }
}

export async function findPageTarget(port) {
  let targets;
  try {
    targets = await getJson(port, '/json/list');
  } catch (err) {
    throw new CdpUnavailableError(port, err.cause?.code ?? err.message);
  }
  const page = Array.isArray(targets) ? targets.find((t) => t.type === 'page') : null;
  if (!page) {
    throw new Error(
      `CDP on port ${port} is reachable but exposes no "page" target. ` +
        'The client UX may still be starting; retry once it is visible.'
    );
  }
  return redactTarget(page);
}
```

`err.cause?.code` is where `fetch` puts `ECONNREFUSED`; it goes into the parenthesised detail, never as the headline, so the message always leads with the actionable fix.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/cdp-discover.test.js`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cdp/discover.js tests/cdp-discover.test.js
git commit -m "feat: CDP discovery with redacted targets and Pengu hint"
```

---

### Task 10: CDP client — attach, evaluate, DOM query

**Files:**
- Create: `src/cdp/client.js`
- Test: `tests/cdp-client.test.js`

**Interfaces:**
- Consumes: `findPageTarget`, `CdpUnavailableError` (Task 9).
- Produces: `class CdpClient` — `new CdpClient({ port, wsFactory, discover })`, `attach() -> Promise<void>` (idempotent; re-runs discovery once if attaching fails), `send(method, params) -> Promise<result>`, `evaluate(expression, { awaitPromise }) -> Promise<value>`, `domQuery(selector, { all, props }) -> Promise<node|node[]>`, `statusSnapshot() -> { attached, port, targetId, targetTitle, lastError }`, `close()`.

`domQuery` is implemented on `Runtime.evaluate` with `returnByValue: true` and a fixed template — the selector is injected with `JSON.stringify`, so it takes no arbitrary code and is **not** gated by `allowEval`. `DOM.getDocument`/`DOM.querySelectorAll` also work (verified) but return node ids, which would need a second round-trip per property.

- [ ] **Step 1: Write the failing test**

`tests/cdp-client.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CdpClient } from '../src/cdp/client.js';
import { CdpUnavailableError } from '../src/cdp/discover.js';

class FakeCdpSocket extends EventEmitter {
  sent = [];
  responder = () => null;
  send(text) {
    const message = JSON.parse(text);
    this.sent.push(message);
    const reply = this.responder(message);
    if (reply !== null) setImmediate(() => this.emit('message', JSON.stringify({ id: message.id, ...reply })));
  }
  close() { this.emit('close'); }
}

function harness({ discover } = {}) {
  const sockets = [];
  const client = new CdpClient({
    port: 8888,
    discover: discover ?? (async () => ({ id: 'ABC', title: 'League Client', webSocketDebuggerUrl: 'ws://127.0.0.1:8888/devtools/page/ABC' })),
    wsFactory: (url) => {
      const socket = new FakeCdpSocket();
      socket.url = url;
      sockets.push(socket);
      setImmediate(() => socket.emit('open'));
      return socket;
    }
  });
  return { client, sockets };
}

test('attach connects to the discovered target socket', async () => {
  const { client, sockets } = harness();
  await client.attach();
  assert.equal(sockets[0].url, 'ws://127.0.0.1:8888/devtools/page/ABC');
  assert.equal(client.statusSnapshot().attached, true);
  assert.equal(client.statusSnapshot().targetId, 'ABC');
  client.close();
});

test('attach is idempotent', async () => {
  const { client, sockets } = harness();
  await client.attach();
  await client.attach();
  assert.equal(sockets.length, 1);
  client.close();
});

test('send correlates responses by id', async () => {
  const { client, sockets } = harness();
  await client.attach();
  sockets[0].responder = (msg) => ({ result: { echo: msg.method } });
  assert.deepEqual(await client.send('Runtime.enable'), { echo: 'Runtime.enable' });
  client.close();
});

test('a CDP protocol error rejects with its message', async () => {
  const { client, sockets } = harness();
  await client.attach();
  sockets[0].responder = () => ({ error: { code: -32000, message: 'Cannot find context' } });
  await assert.rejects(client.send('Runtime.evaluate', {}), /Cannot find context/);
  client.close();
});

test('evaluate returns the by-value result', async () => {
  const { client, sockets } = harness();
  await client.attach();
  sockets[0].responder = (msg) => {
    assert.equal(msg.params.returnByValue, true);
    return { result: { result: { type: 'number', value: 42 } } };
  };
  assert.equal(await client.evaluate('1 + 41'), 42);
  client.close();
});

test('evaluate surfaces a page exception as an error', async () => {
  const { client, sockets } = harness();
  await client.attach();
  sockets[0].responder = () => ({
    result: { exceptionDetails: { exception: { description: 'ReferenceError: nope is not defined' } } }
  });
  await assert.rejects(client.evaluate('nope'), /ReferenceError: nope is not defined/);
  client.close();
});

test('domQuery passes the selector as data, not code', async () => {
  const { client, sockets } = harness();
  await client.attach();
  sockets[0].responder = (msg) => {
    assert.ok(msg.params.expression.includes(JSON.stringify('.lol-uikit-flat-button')));
    return { result: { result: { type: 'object', value: [{ tag: 'BUTTON' }] } } };
  };
  const nodes = await client.domQuery('.lol-uikit-flat-button', { all: true, props: ['textContent'] });
  assert.deepEqual(nodes, [{ tag: 'BUTTON' }]);
  client.close();
});

test('attach failure is reported as CDP unavailable', async () => {
  const { client } = harness({
    discover: async () => {
      throw new CdpUnavailableError(8888, 'ECONNREFUSED');
    }
  });
  await assert.rejects(client.attach(), /Pengu Loader not active/);
  assert.equal(client.statusSnapshot().attached, false);
  assert.match(client.statusSnapshot().lastError, /Pengu Loader/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/cdp-client.test.js`
Expected: FAIL — `Cannot find module '../src/cdp/client.js'`.

- [ ] **Step 3: Write the implementation**

`src/cdp/client.js`:

```js
import { WebSocket } from 'ws';
import { findPageTarget } from './discover.js';

export class CdpClient {
  #socket = null;
  #target = null;
  #pending = new Map();
  #nextId = 1;
  #lastError = null;
  #attaching = null;

  constructor({ port, wsFactory = (url) => new WebSocket(url), discover = findPageTarget } = {}) {
    this.port = port;
    this.wsFactory = wsFactory;
    this.discover = discover;
  }

  async attach() {
    if (this.#socket) return;
    this.#attaching ??= this.#attachOnce().finally(() => {
      this.#attaching = null;
    });
    return this.#attaching;
  }

  async #attachOnce() {
    try {
      await this.#connect();
    } catch (err) {
      // Discovery may hold a stale target id after a UX restart; re-run it once.
      this.#lastError = err.message;
      try {
        await this.#connect();
      } catch (retryErr) {
        this.#lastError = retryErr.message;
        throw retryErr;
      }
    }
    this.#lastError = null;
  }

  async #connect() {
    const target = await this.discover(this.port);
    const socket = this.wsFactory(target.webSocketDebuggerUrl);

    socket.on('message', (raw) => this.#handleMessage(raw));
    socket.on('close', () => {
      if (this.#socket === socket) {
        this.#socket = null;
        this.#target = null;
      }
      for (const { reject } of this.#pending.values()) reject(new Error('CDP socket closed'));
      this.#pending.clear();
    });
    socket.on('error', (err) => {
      this.#lastError = `CDP socket error: ${err?.code ?? err?.message ?? 'unknown'}`;
    });

    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    this.#socket = socket;
    this.#target = target;
  }

  #handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'));
    } catch {
      return;
    }
    if (message.id === undefined) return; // an unsolicited CDP event; nothing subscribes yet
    const waiter = this.#pending.get(message.id);
    if (!waiter) return;
    this.#pending.delete(message.id);
    if (message.error) waiter.reject(new Error(`CDP ${message.error.code}: ${message.error.message}`));
    else waiter.resolve(message.result);
  }

  async send(method, params = {}) {
    await this.attach();
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#socket.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        this.#pending.delete(id);
        reject(err);
      }
    });
  }

  async evaluate(expression, { awaitPromise = false } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true
    });
    if (result.exceptionDetails) {
      const detail =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        'unknown page exception';
      throw new Error(`Page threw: ${detail}`);
    }
    return result.result?.value;
  }

  async domQuery(selector, { all = false, props = [] } = {}) {
    const expression = `(() => {
      const sel = ${JSON.stringify(selector)};
      const props = ${JSON.stringify(props)};
      const describe = (el) => {
        const out = {
          tag: el.tagName,
          id: el.id || undefined,
          className: el.className || undefined,
          text: (el.textContent || '').trim().slice(0, 200) || undefined
        };
        for (const p of props) out[p] = el[p] ?? el.getAttribute(p) ?? undefined;
        return out;
      };
      const nodes = Array.from(document.querySelectorAll(sel));
      return ${all ? 'nodes.map(describe)' : 'nodes.length ? describe(nodes[0]) : null'};
    })()`;
    return this.evaluate(expression);
  }

  statusSnapshot() {
    return {
      attached: this.#socket !== null,
      port: this.port,
      targetId: this.#target?.id ?? null,
      targetTitle: this.#target?.title ?? null,
      lastError: this.#lastError
    };
  }

  close() {
    const socket = this.#socket;
    this.#socket = null;
    this.#target = null;
    socket?.close();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/cdp-client.test.js`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cdp/client.js tests/cdp-client.test.js
git commit -m "feat: CDP client with evaluate and DOM query"
```

---

### Task 11: Curated endpoint table

**Files:**
- Create: `src/tools/curated.js`
- Test: `tests/curated.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `ENDPOINTS` — a frozen array of `{ method, path, group, description }`; `filterEndpoints(filter) -> ENDPOINTS subset` (case-insensitive substring match against `path`, `group`, and `description`; empty/absent filter returns everything); `GROUPS -> string[]` (unique groups, in table order).

Paths use `{placeholder}` for path parameters. This is the full list from the spec's "Curated endpoints" section — every entry there must appear.

- [ ] **Step 1: Write the failing test**

`tests/curated.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENDPOINTS, GROUPS, filterEndpoints } from '../src/tools/curated.js';

test('every entry has the required shape', () => {
  assert.ok(ENDPOINTS.length >= 30, `expected the full curated table, got ${ENDPOINTS.length}`);
  for (const entry of ENDPOINTS) {
    assert.ok(entry.path.startsWith('/'), `${entry.path} must start with /`);
    assert.match(entry.method, /^(GET|POST|PATCH|PUT|DELETE)$/);
    assert.ok(entry.group.length > 0);
    assert.ok(entry.description.length > 0);
  }
});

test('the spec anchors are present', () => {
  const paths = ENDPOINTS.map((e) => e.path);
  for (const path of [
    '/lol-gameflow/v1/gameflow-phase',
    '/lol-champ-select/v1/session',
    '/lol-summoner/v1/current-summoner',
    '/lol-matchmaking/v1/ready-check/accept',
    '/riotclient/region-locale'
  ]) {
    assert.ok(paths.includes(path), `${path} missing from the curated table`);
  }
});

test('paths are unique per method', () => {
  const keys = ENDPOINTS.map((e) => `${e.method} ${e.path}`);
  assert.equal(new Set(keys).size, keys.length);
});

test('filterEndpoints matches path, group, and description case-insensitively', () => {
  assert.equal(filterEndpoints().length, ENDPOINTS.length);
  assert.equal(filterEndpoints('').length, ENDPOINTS.length);
  assert.ok(filterEndpoints('champ-select').every((e) => `${e.path} ${e.group} ${e.description}`.toLowerCase().includes('champ-select')));
  assert.ok(filterEndpoints('CHAMP-SELECT').length > 0);
  assert.equal(filterEndpoints('no-such-endpoint-anywhere').length, 0);
});

test('GROUPS lists each group once', () => {
  assert.equal(new Set(GROUPS).size, GROUPS.length);
  assert.ok(GROUPS.includes('gameflow'));
});

test('the table is immutable', () => {
  assert.throws(() => ENDPOINTS.push({}), TypeError);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/curated.test.js`
Expected: FAIL — `Cannot find module '../src/tools/curated.js'`.

- [ ] **Step 3: Write the implementation**

`src/tools/curated.js`. Transcribe the spec's list; `{id}` and `{puuid}` mark path parameters.

```js
const table = [
  { method: 'GET', path: '/lol-gameflow/v1/gameflow-phase', group: 'gameflow', description: 'Current phase string (None, Lobby, ReadyCheck, ChampSelect, InProgress, EndOfGame)' },
  { method: 'GET', path: '/lol-gameflow/v1/session', group: 'gameflow', description: 'Full gameflow session including queue and map' },

  { method: 'GET', path: '/lol-champ-select/v1/session', group: 'champ-select', description: 'Champ select session: actions, my team, bans, timer' },
  { method: 'PATCH', path: '/lol-champ-select/v1/session/actions/{id}', group: 'champ-select', description: 'Set or complete a pick/ban action' },
  { method: 'GET', path: '/lol-champ-select/v1/bannable-champion-ids', group: 'champ-select', description: 'Champion ids currently bannable' },
  { method: 'GET', path: '/lol-champ-select/v1/pickable-champion-ids', group: 'champ-select', description: 'Champion ids currently pickable' },

  { method: 'GET', path: '/lol-summoner/v1/current-summoner', group: 'summoner', description: 'Logged-in summoner: puuid, gameName, tagLine, level' },
  { method: 'GET', path: '/lol-summoner/v1/summoners/{id}', group: 'summoner', description: 'Summoner by summonerId' },
  { method: 'GET', path: '/lol-summoner/v2/summoners/puuid/{puuid}', group: 'summoner', description: 'Summoner by puuid' },
  { method: 'GET', path: '/lol-summoner/v1/summoners/aliases', group: 'summoner', description: 'Riot ID aliases for a set of puuids' },
  { method: 'GET', path: '/lol-summoner/v1/alias/lookup', group: 'summoner', description: 'Look up a summoner by Riot ID alias' },

  { method: 'GET', path: '/lol-lobby/v2/lobby', group: 'lobby', description: 'Current lobby: queue, members, invitations' },
  { method: 'POST', path: '/lol-lobby/v2/lobby/matchmaking/search', group: 'lobby', description: 'Start matchmaking search' },
  { method: 'DELETE', path: '/lol-lobby/v2/lobby/matchmaking/search', group: 'lobby', description: 'Stop matchmaking search' },
  { method: 'POST', path: '/lol-lobby/v2/play-again', group: 'lobby', description: 'Recreate the previous lobby' },
  { method: 'GET', path: '/lol-lobby/v2/notifications', group: 'lobby', description: 'Lobby notifications' },
  { method: 'GET', path: '/lol-lobby/v2/lobby/invitations', group: 'lobby', description: 'Pending lobby invitations' },

  { method: 'GET', path: '/lol-matchmaking/v1/ready-check', group: 'matchmaking', description: 'Ready check state and remaining time' },
  { method: 'POST', path: '/lol-matchmaking/v1/ready-check/accept', group: 'matchmaking', description: 'Accept the ready check' },

  { method: 'GET', path: '/lol-end-of-game/v1/eog-stats-block', group: 'end-of-game', description: 'End-of-game stats block' },
  { method: 'GET', path: '/lol-honor/v1/honor', group: 'end-of-game', description: 'Honor state' },
  { method: 'GET', path: '/lol-honor/v1/ballot', group: 'end-of-game', description: 'Current honor ballot' },

  { method: 'GET', path: '/lol-chat/v1/me', group: 'chat', description: 'Own chat presence and availability' },
  { method: 'GET', path: '/lol-chat/v1/friends', group: 'chat', description: 'Friend list with presence' },
  { method: 'GET', path: '/lol-chat/v1/friend-groups', group: 'chat', description: 'Friend group definitions' },
  { method: 'GET', path: '/lol-chat/v1/conversations', group: 'chat', description: 'Open conversations' },

  { method: 'GET', path: '/lol-ranked/v1/ranked-stats/{puuid}', group: 'ranked', description: 'Ranked stats per queue for a puuid' },
  { method: 'GET', path: '/lol-match-history/v1/products/lol/current-summoner/matches', group: 'match-history', description: 'Recent matches for the current summoner' },
  { method: 'GET', path: '/lol-match-history/v1/games/{id}', group: 'match-history', description: 'Full game detail by gameId' },

  { method: 'GET', path: '/lol-challenges/v1/summary-player-data/local-player', group: 'challenges', description: 'Local player challenge summary' },
  { method: 'GET', path: '/lol-settings/v1/local/video', group: 'settings', description: 'Local video settings blob' },
  { method: 'GET', path: '/lol-champions/v1/inventories/{id}/champions-minimal', group: 'inventory', description: 'Owned champions, minimal shape' },
  { method: 'GET', path: '/lol-loot/v1/player-loot', group: 'inventory', description: 'Loot inventory' },
  { method: 'GET', path: '/lol-inventory/v2/inventory/CHAMPION', group: 'inventory', description: 'Inventory by type (CHAMPION, SKIN, WARD_SKIN, ...)' },
  { method: 'GET', path: '/lol-catalog/v1/items/EMOTE', group: 'inventory', description: 'Store catalog for a type' },

  { method: 'GET', path: '/riotclient/region-locale', group: 'riotclient', description: 'Region, locale, and web region' }
];

export const ENDPOINTS = Object.freeze(table.map((entry) => Object.freeze(entry)));
export const GROUPS = Object.freeze([...new Set(ENDPOINTS.map((e) => e.group))]);

export function filterEndpoints(filter) {
  if (typeof filter !== 'string' || filter.trim().length === 0) return ENDPOINTS;
  const needle = filter.trim().toLowerCase();
  return ENDPOINTS.filter((e) =>
    `${e.method} ${e.path} ${e.group} ${e.description}`.toLowerCase().includes(needle)
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/curated.test.js`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tools/curated.js tests/curated.test.js
git commit -m "feat: curated LCU endpoint table"
```

---

### Task 12: Server skeleton, result helpers, and `lol_status`

**Files:**
- Create: `src/tools/result.js`, `src/tools/status.js`, `src/index.js`, `tests/helpers/context.js`
- Test: `tests/tools-status.test.js`

**Interfaces:**
- Consumes: `loadConfig` (Task 1), `redactSecrets` (Task 3), `LcuClient` (Task 5), `RingBuffer` (Task 6), `LcuEventTap` (Task 8), `CdpClient` (Task 10).
- Produces:
  - `src/tools/result.js`: `ok(value) -> { content: [{ type: 'text', text }] }`, `fail(message) -> { isError: true, content: [...] }`, `guard(handler, ctx) -> handler` (catches, redacts the LCU password out of the message, returns `fail`)
  - `src/tools/status.js`: `registerStatusTool(server, ctx)`
  - `src/index.js`: `buildContext({ env }) -> ctx`, `createServer(ctx) -> McpServer`, and a `main()` that runs when the file is the entry point
  - `ctx` shape, relied on by every later task: `{ config, lcu, cdp, buffer, tap, secrets() }` where `secrets()` returns the array of live secret strings to redact (`[password]` or `[]`).
  - `tests/helpers/context.js`: `fakeContext(overrides = {}) -> ctx` — the shared test double every later task's tests import. It is a helper module, not a test file, so it declares no tests.

- [ ] **Step 1: Write the shared test helper**

`tests/helpers/context.js`. This is a plain module under `tests/helpers/`, not a test file — `node --test` only treats `*.test.js` as a suite, so it contributes no tests of its own. Every later task's tests import `fakeContext` from here.

```js
import { RingBuffer } from '../../src/lcu/buffer.js';

export function fakeContext(overrides = {}) {
  const buffer = new RingBuffer(10);
  return {
    config: { allowEval: true, cdpPort: 8888, eventBufferSize: 10, writeAllowlist: [], configPath: 'config/allowlist.json' },
    buffer,
    lcu: {
      statusSnapshot: () => ({ connected: true, port: 29669, lockfilePath: 'L', lastError: null }),
      request: async () => ({ status: 200, body: 'None' }),
      get: async () => ({ status: 200, body: 'None' })
    },
    cdp: {
      statusSnapshot: () => ({ attached: false, port: 8888, targetId: null, targetTitle: null, lastError: null }),
      evaluate: async () => null,
      domQuery: async () => null
    },
    tap: {
      statusSnapshot: () => ({ running: false, connected: false, filters: [], attempts: 0, buffered: buffer.length, lastError: null }),
      start: async () => {},
      stop: () => {}
    },
    secrets: () => ['S3cr3t-Pa55'],
    ...overrides
  };
}
```

- [ ] **Step 2: Write the failing test**

`tests/tools-status.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/index.js';
import { fail, guard, ok } from '../src/tools/result.js';
import { fakeContext } from './helpers/context.js';

async function connect(ctx) {
  const server = createServer(ctx);
  const client = new Client({ name: 'test', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);
  return { client, server };
}

test('ok and fail produce MCP content shapes', () => {
  assert.deepEqual(ok({ a: 1 }), { content: [{ type: 'text', text: '{\n  "a": 1\n}' }] });
  assert.equal(fail('nope').isError, true);
});

test('guard redacts secrets out of thrown messages', async () => {
  const ctx = fakeContext();
  const handler = guard(async () => {
    throw new Error('connect wss://riot:S3cr3t-Pa55@127.0.0.1:1 failed');
  }, ctx);
  const result = await handler({});
  assert.equal(result.isError, true);
  assert.ok(!result.content[0].text.includes('S3cr3t-Pa55'));
  assert.ok(result.content[0].text.includes('***'));
});

test('the server registers exactly the tools wired so far', async () => {
  const { client } = await connect(fakeContext());
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['lol_status']);
  await client.close();
});

test('lol_status reports both subsystems and the config', async () => {
  const { client } = await connect(fakeContext());
  const result = await client.callTool({ name: 'lol_status', arguments: {} });
  const status = JSON.parse(result.content[0].text);
  assert.equal(status.lcu.port, 29669);
  assert.equal(status.cdp.attached, false);
  assert.equal(status.events.running, false);
  assert.equal(status.config.allowEval, true);
  assert.equal(status.config.cdpPort, 8888);
  await client.close();
});

test('lol_status never leaks the password', async () => {
  const { client } = await connect(fakeContext());
  const result = await client.callTool({ name: 'lol_status', arguments: {} });
  assert.ok(!JSON.stringify(result).includes('S3cr3t-Pa55'));
  await client.close();
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test tests/tools-status.test.js`
Expected: FAIL — `Cannot find module '../src/index.js'`.

- [ ] **Step 4: Write the result helpers**

`src/tools/result.js`:

```js
import { redactSecrets } from '../redact.js';

export function ok(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }] };
}

export function fail(message) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export function guard(handler, ctx) {
  return async (args, extra) => {
    try {
      return await handler(args, extra);
    } catch (err) {
      return fail(redactSecrets(err?.message ?? String(err), ctx.secrets?.() ?? []));
    }
  };
}
```

- [ ] **Step 5: Write the status tool**

`src/tools/status.js`:

```js
import { guard, ok } from './result.js';

export function registerStatusTool(server, ctx) {
  server.registerTool(
    'lol_status',
    {
      title: 'League client status',
      description:
        'Health of both subsystems: LCU (lockfile-derived port, connected state) and CDP ' +
        '(Pengu remote debugging port, attached target), plus event tap state and effective config. ' +
        'Call this first when another tool fails.',
      inputSchema: {}
    },
    guard(
      async () =>
        ok({
          lcu: ctx.lcu.statusSnapshot(),
          cdp: ctx.cdp.statusSnapshot(),
          events: ctx.tap.statusSnapshot(),
          config: {
            configPath: ctx.config.configPath,
            cdpPort: ctx.config.cdpPort,
            allowEval: ctx.config.allowEval,
            eventBufferSize: ctx.config.eventBufferSize,
            writeAllowlistEntries: ctx.config.writeAllowlist.length
          }
        }),
      ctx
    )
  );
}
```

- [ ] **Step 6: Write the entry point**

`src/index.js`. All nine tools eventually register here, but the register functions for Tasks 13–16 do not exist yet, so this step wires `lol_status` only — each later task adds its own import and call, and extends the Step-2 name assertion by its own names. Registration order, as tasks land: status, passthrough, endpoints, events, dom.

```js
#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { LcuClient } from './lcu/client.js';
import { RingBuffer } from './lcu/buffer.js';
import { LcuEventTap } from './lcu/events.js';
import { CdpClient } from './cdp/client.js';
import { registerStatusTool } from './tools/status.js';

export function buildContext({ env = process.env } = {}) {
  const config = loadConfig({ env });
  const lcu = new LcuClient({});
  const buffer = new RingBuffer(config.eventBufferSize);
  const tap = new LcuEventTap({ client: lcu, buffer });
  const cdp = new CdpClient({ port: config.cdpPort });
  return {
    config,
    lcu,
    buffer,
    tap,
    cdp,
    // The live password, for guard() to strip out of error text. No tool returns it.
    secrets: () => (lcu.currentPassword() ? [lcu.currentPassword()] : [])
  };
}

export function createServer(ctx) {
  const server = new McpServer({ name: 'lcu-mcp', version: '0.1.0' });
  registerStatusTool(server, ctx);
  return server;
}

async function main() {
  const ctx = buildContext({});
  const server = createServer(ctx);
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  main().catch((err) => {
    process.stderr.write(`lcu-mcp failed to start: ${err.message}\n`);
    process.exitCode = 1;
  });
}
```

`statusSnapshot()` deliberately omits the password, so add a separate accessor to `src/lcu/client.js` for `secrets()` to use:

```js
  currentPassword() {
    return this.#creds?.password ?? null;
  }
```

The entry-point guard compares `import.meta.url` against `process.argv[1]` with backslashes normalised, because on Windows `argv[1]` is a `C:\...` path while `import.meta.url` is a `file:///C:/...` URL.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — every suite, including the 5 tests in `tests/tools-status.test.js`.

- [ ] **Step 8: Commit**

```bash
git add src/index.js src/tools/result.js src/tools/status.js src/lcu/client.js tests/helpers/context.js tests/tools-status.test.js
git commit -m "feat: MCP server skeleton with lol_status"
```

---

### Task 13: `lol_get` and `lol_request` with allowlist enforcement

**Files:**
- Create: `src/tools/passthrough.js`
- Modify: `src/index.js` (import and call `registerPassthroughTools`), `tests/tools-status.test.js` (add `lol_get`, `lol_request` to the expected name list)
- Test: `tests/tools-passthrough.test.js`

**Interfaces:**
- Consumes: `ctx.lcu.request` (Task 5), `checkWrite` (Task 2), `ok`/`fail`/`guard` (Task 12), `fakeContext` from `tests/helpers/context.js` (Task 12).
- Produces: `registerPassthroughTools(server, ctx)` registering `lol_get({ path })` and `lol_request({ method, path, body? })`.

`lol_request` is the single enforcement point for the write allowlist. A denied call returns `isError: true` with the paste-ready message from `checkWrite` and must **not** touch the client.

- [ ] **Step 1: Write the failing test**

`tests/tools-passthrough.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/index.js';
import { fakeContext } from './helpers/context.js';

async function connect(ctx) {
  const server = createServer(ctx);
  const client = new Client({ name: 'test', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);
  return client;
}

function recordingContext(overrides = {}) {
  const calls = [];
  const ctx = fakeContext({
    config: { ...fakeContext().config, writeAllowlist: ['POST /lol-matchmaking/v1/ready-check/accept'], ...overrides }
  });
  ctx.lcu = {
    ...ctx.lcu,
    request: async (method, path, body) => {
      calls.push({ method, path, body });
      return { status: 204, body: '' };
    },
    get: async (path) => {
      calls.push({ method: 'GET', path });
      return { status: 200, body: { phase: 'Lobby' } };
    }
  };
  return { ctx, calls };
}

test('lol_get returns status and body', async () => {
  const { ctx, calls } = recordingContext();
  const client = await connect(ctx);
  const result = await client.callTool({ name: 'lol_get', arguments: { path: '/lol-gameflow/v1/session' } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), { status: 200, body: { phase: 'Lobby' } });
  assert.deepEqual(calls, [{ method: 'GET', path: '/lol-gameflow/v1/session' }]);
  await client.close();
});

test('lol_get rejects a path without a leading slash', async () => {
  const { ctx, calls } = recordingContext();
  const client = await connect(ctx);
  const result = await client.callTool({ name: 'lol_get', arguments: { path: 'lol-gameflow/v1/session' } });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
  await client.close();
});

test('an allowlisted write reaches the client', async () => {
  const { ctx, calls } = recordingContext();
  const client = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_request',
    arguments: { method: 'POST', path: '/lol-matchmaking/v1/ready-check/accept' }
  });
  assert.equal(result.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  await client.close();
});

test('a denied write is refused without touching the client', async () => {
  const { ctx, calls } = recordingContext();
  const client = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_request',
    arguments: { method: 'POST', path: '/lol-lobby/v2/lobby', body: { queueId: 430 } }
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /"POST \/lol-lobby\/v2\/lobby"/);
  assert.match(result.content[0].text, /writeAllowlist/);
  assert.match(result.content[0].text, /config\/allowlist\.json/);
  assert.equal(calls.length, 0, 'the request must not be sent');
  await client.close();
});

test('GET through lol_request needs no allowlist entry', async () => {
  const { ctx, calls } = recordingContext();
  const client = await connect(ctx);
  const result = await client.callTool({ name: 'lol_request', arguments: { method: 'GET', path: '/anything' } });
  assert.equal(result.isError, undefined);
  assert.equal(calls.length, 1);
  await client.close();
});

test('an LCU failure comes back as a tool error', async () => {
  const { ctx } = recordingContext();
  ctx.lcu.get = async () => {
    throw new Error('League client is not running: no lockfile at C:\\Riot Games\\League of Legends\\lockfile');
  };
  const client = await connect(ctx);
  const result = await client.callTool({ name: 'lol_get', arguments: { path: '/lol-gameflow/v1/session' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not running/);
  await client.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/tools-passthrough.test.js`
Expected: FAIL — `Unknown tool: lol_get`.

- [ ] **Step 3: Write the implementation**

`src/tools/passthrough.js`:

```js
import { z } from 'zod';
import { checkWrite } from '../allowlist.js';
import { fail, guard, ok } from './result.js';

const pathSchema = z
  .string()
  .startsWith('/', 'LCU paths must start with "/", e.g. /lol-gameflow/v1/gameflow-phase');

export function registerPassthroughTools(server, ctx) {
  server.registerTool(
    'lol_get',
    {
      title: 'GET an LCU endpoint',
      description:
        'GET any LCU path and return { status, body }. Always allowed. ' +
        'Use lol_endpoints to discover the paths this client is known to expose.',
      inputSchema: { path: pathSchema }
    },
    guard(async ({ path }) => ok(await ctx.lcu.get(path)), ctx)
  );

  server.registerTool(
    'lol_request',
    {
      title: 'Call an LCU endpoint with any verb',
      description:
        'Send any HTTP verb to an LCU path. GET and HEAD are always allowed; every other verb ' +
        'must match an entry in the write allowlist, otherwise the call is refused with the exact ' +
        'config line that would permit it.',
      inputSchema: {
        method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']),
        path: pathSchema,
        body: z.unknown().optional().describe('JSON request body; omit for verbs that take none')
      }
    },
    guard(async ({ method, path, body }) => {
      const verdict = checkWrite(method, path, ctx.config.writeAllowlist);
      if (!verdict.allowed) return fail(`${verdict.message} (config file: ${ctx.config.configPath})`);
      return ok(await ctx.lcu.request(method, path, body));
    }, ctx)
  );
}
```

- [ ] **Step 4: Register the tools**

In `src/index.js`, add `import { registerPassthroughTools } from './tools/passthrough.js';` and call `registerPassthroughTools(server, ctx);` inside `createServer`, after `registerStatusTool`.

- [ ] **Step 5: Update the tool-name assertion**

In `tests/tools-status.test.js`, change the expected list to `['lol_get', 'lol_request', 'lol_status']` (sorted).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — including the 6 tests in `tests/tools-passthrough.test.js`.

- [ ] **Step 7: Commit**

```bash
git add src/tools/passthrough.js src/index.js tests/tools-passthrough.test.js tests/tools-status.test.js
git commit -m "feat: lol_get and lol_request with write allowlist enforcement"
```

---

### Task 14: `lol_endpoints`

**Files:**
- Create: `src/tools/endpoints.js`
- Modify: `src/index.js`, `tests/tools-status.test.js` (add `lol_endpoints` to the expected list)
- Test: `tests/tools-endpoints.test.js`

**Interfaces:**
- Consumes: `ENDPOINTS`, `GROUPS`, `filterEndpoints` (Task 11), `ok`/`guard` (Task 12).
- Produces: `registerEndpointsTool(server, ctx)` registering `lol_endpoints({ filter? })`, returning `{ total, matched, groups, endpoints }`.

- [ ] **Step 1: Write the failing test**

`tests/tools-endpoints.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/index.js';
import { ENDPOINTS } from '../src/tools/curated.js';
import { fakeContext } from './helpers/context.js';

async function connect() {
  const server = createServer(fakeContext());
  const client = new Client({ name: 'test', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);
  return client;
}

test('lol_endpoints lists the whole table by default', async () => {
  const client = await connect();
  const result = await client.callTool({ name: 'lol_endpoints', arguments: {} });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.total, ENDPOINTS.length);
  assert.equal(payload.matched, ENDPOINTS.length);
  assert.ok(payload.groups.includes('champ-select'));
  await client.close();
});

test('lol_endpoints filters', async () => {
  const client = await connect();
  const result = await client.callTool({ name: 'lol_endpoints', arguments: { filter: 'ready-check' } });
  const payload = JSON.parse(result.content[0].text);
  assert.ok(payload.matched >= 2);
  assert.ok(payload.matched < payload.total);
  assert.ok(payload.endpoints.every((e) => e.path.includes('ready-check')));
  await client.close();
});

test('a filter matching nothing returns an empty list, not an error', async () => {
  const client = await connect();
  const result = await client.callTool({ name: 'lol_endpoints', arguments: { filter: 'zzz-nope' } });
  assert.equal(result.isError, undefined);
  assert.equal(JSON.parse(result.content[0].text).matched, 0);
  await client.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/tools-endpoints.test.js`
Expected: FAIL — `Unknown tool: lol_endpoints`.

- [ ] **Step 3: Write the implementation**

`src/tools/endpoints.js`:

```js
import { z } from 'zod';
import { ENDPOINTS, GROUPS, filterEndpoints } from './curated.js';
import { guard, ok } from './result.js';

export function registerEndpointsTool(server, ctx) {
  server.registerTool(
    'lol_endpoints',
    {
      title: 'List curated LCU endpoints',
      description:
        'The curated endpoint table: the LCU paths this project actually uses, with the verb, a ' +
        'group, and a one-line description. {placeholder} marks a path parameter. Optional filter is ' +
        'a case-insensitive substring matched against verb, path, group, and description.',
      inputSchema: {
        filter: z.string().optional().describe('e.g. "champ-select", "ready-check", "summoner"')
      }
    },
    guard(async ({ filter }) => {
      const endpoints = filterEndpoints(filter);
      return ok({ total: ENDPOINTS.length, matched: endpoints.length, groups: GROUPS, endpoints });
    }, ctx)
  );
}
```

- [ ] **Step 4: Register the tool**

In `src/index.js`, import `registerEndpointsTool` and call it after `registerPassthroughTools`.

- [ ] **Step 5: Update the tool-name assertion**

In `tests/tools-status.test.js`, expect `['lol_endpoints', 'lol_get', 'lol_request', 'lol_status']`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — including the 3 tests in `tests/tools-endpoints.test.js`.

- [ ] **Step 7: Commit**

```bash
git add src/tools/endpoints.js src/index.js tests/tools-endpoints.test.js tests/tools-status.test.js
git commit -m "feat: lol_endpoints tool over the curated table"
```

---

### Task 15: `lol_events_start`, `lol_events_poll`, `lol_events_stop`

**Files:**
- Create: `src/tools/events.js`
- Modify: `src/index.js`, `tests/tools-status.test.js` (add the three event tool names)
- Test: `tests/tools-events.test.js`

**Interfaces:**
- Consumes: `ctx.tap.start/stop/statusSnapshot` (Task 8), `ctx.buffer.since` (Task 6), `ok`/`guard` (Task 12).
- Produces: `registerEventTools(server, ctx)` registering:
  - `lol_events_start({ filters? })` → `{ started: true, filters, note }`
  - `lol_events_poll({ since?, limit?, filter? })` → `{ entries, cursor, dropped, remaining, running }`
  - `lol_events_stop({})` → `{ stopped: true, buffered }`

`since` defaults to 0, `limit` defaults to 100 (max 500). Restarting is not an error. Polling while stopped is not an error either — buffered entries are still drained.

- [ ] **Step 1: Write the failing test**

`tests/tools-events.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/index.js';
import { RingBuffer } from '../src/lcu/buffer.js';
import { fakeContext } from './helpers/context.js';

function tapContext() {
  const buffer = new RingBuffer(100);
  const calls = { start: [], stop: 0 };
  let running = false;
  let filters = [];
  const ctx = fakeContext({ buffer });
  ctx.buffer = buffer;
  ctx.tap = {
    start: async (f = []) => {
      running = true;
      filters = f;
      calls.start.push(f);
    },
    stop: () => {
      running = false;
      calls.stop += 1;
    },
    statusSnapshot: () => ({ running, connected: running, filters, attempts: 0, buffered: buffer.length, lastError: null })
  };
  return { ctx, buffer, calls };
}

async function connect(ctx) {
  const server = createServer(ctx);
  const client = new Client({ name: 'test', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);
  return client;
}

test('lol_events_start passes filters to the tap', async () => {
  const { ctx, calls } = tapContext();
  const client = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_events_start',
    arguments: { filters: ['/lol-champ-select/', '/lol-gameflow/'] }
  });
  assert.deepEqual(JSON.parse(result.content[0].text).filters, ['/lol-champ-select/', '/lol-gameflow/']);
  assert.deepEqual(calls.start, [['/lol-champ-select/', '/lol-gameflow/']]);
  await client.close();
});

test('lol_events_start twice is not an error and replaces filters', async () => {
  const { ctx, calls } = tapContext();
  const client = await connect(ctx);
  await client.callTool({ name: 'lol_events_start', arguments: { filters: ['/a/'] } });
  const second = await client.callTool({ name: 'lol_events_start', arguments: { filters: ['/b/'] } });
  assert.equal(second.isError, undefined);
  assert.deepEqual(calls.start, [['/a/'], ['/b/']]);
  await client.close();
});

test('lol_events_poll drains with a cursor', async () => {
  const { ctx, buffer } = tapContext();
  const client = await connect(ctx);
  await client.callTool({ name: 'lol_events_start', arguments: {} });
  buffer.push({ eventType: 'Update', uri: '/lol-gameflow/v1/session', data: 1, truncated: false });
  buffer.push({ eventType: 'Update', uri: '/lol-champ-select/v1/session', data: 2, truncated: false });

  const first = JSON.parse((await client.callTool({ name: 'lol_events_poll', arguments: {} })).content[0].text);
  assert.equal(first.entries.length, 2);
  assert.equal(first.cursor, 2);
  assert.equal(first.dropped, 0);

  const second = JSON.parse(
    (await client.callTool({ name: 'lol_events_poll', arguments: { since: first.cursor } })).content[0].text
  );
  assert.equal(second.entries.length, 0);
  assert.equal(second.cursor, 2);
  await client.close();
});

test('lol_events_poll honours limit and filter', async () => {
  const { ctx, buffer } = tapContext();
  const client = await connect(ctx);
  for (let i = 0; i < 5; i += 1) buffer.push({ eventType: 'Update', uri: '/lol-gameflow/v1/session', data: i });
  buffer.push({ eventType: 'Update', uri: '/lol-champ-select/v1/session', data: 'cs' });

  const limited = JSON.parse((await client.callTool({ name: 'lol_events_poll', arguments: { limit: 2 } })).content[0].text);
  assert.equal(limited.entries.length, 2);
  assert.equal(limited.remaining, 4);

  const filtered = JSON.parse(
    (await client.callTool({ name: 'lol_events_poll', arguments: { filter: '/lol-champ-select/' } })).content[0].text
  );
  assert.equal(filtered.entries.length, 1);
  await client.close();
});

test('lol_events_poll reports dropped after the buffer wraps', async () => {
  const { ctx } = tapContext();
  ctx.buffer = new RingBuffer(3);
  const client = await connect(ctx);
  for (let i = 0; i < 10; i += 1) ctx.buffer.push({ eventType: 'Update', uri: '/x', data: i });
  const payload = JSON.parse((await client.callTool({ name: 'lol_events_poll', arguments: { since: 2 } })).content[0].text);
  assert.equal(payload.dropped, 5);
  await client.close();
});

test('lol_events_stop stops the tap and reports what is buffered', async () => {
  const { ctx, calls, buffer } = tapContext();
  const client = await connect(ctx);
  await client.callTool({ name: 'lol_events_start', arguments: {} });
  buffer.push({ eventType: 'Update', uri: '/x' });
  const payload = JSON.parse((await client.callTool({ name: 'lol_events_stop', arguments: {} })).content[0].text);
  assert.equal(payload.stopped, true);
  assert.equal(payload.buffered, 1);
  assert.equal(calls.stop, 1);
  await client.close();
});

test('limit above the cap is rejected by schema validation', async () => {
  const { ctx } = tapContext();
  const client = await connect(ctx);
  const result = await client.callTool({ name: 'lol_events_poll', arguments: { limit: 5000 } });
  assert.equal(result.isError, true);
  await client.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/tools-events.test.js`
Expected: FAIL — `Unknown tool: lol_events_start`.

- [ ] **Step 3: Write the implementation**

`src/tools/events.js`:

```js
import { z } from 'zod';
import { guard, ok } from './result.js';

export function registerEventTools(server, ctx) {
  server.registerTool(
    'lol_events_start',
    {
      title: 'Start buffering LCU events',
      description:
        'Open the OnJsonApiEvent tap and buffer events in memory. Filters are URI prefixes applied ' +
        'at ingest, e.g. "/lol-champ-select/" — the unfiltered firehose fills the buffer in seconds, ' +
        'so pass filters unless you truly want everything. Calling this while already running ' +
        'replaces the filters and keeps buffered entries.',
      inputSchema: {
        filters: z
          .array(z.string().startsWith('/'))
          .optional()
          .describe('URI prefixes, e.g. ["/lol-champ-select/", "/lol-gameflow/"]')
      }
    },
    guard(async ({ filters = [] }) => {
      await ctx.tap.start(filters);
      return ok({
        started: true,
        filters,
        note:
          filters.length === 0
            ? `No filters: every Create/Update/Delete is buffered and the oldest are evicted after ${ctx.config.eventBufferSize} entries.`
            : 'Filters apply only to events arriving from now on.'
      });
    }, ctx)
  );

  server.registerTool(
    'lol_events_poll',
    {
      title: 'Drain buffered LCU events',
      description:
        'Return buffered events with seq greater than "since", plus the new cursor. A non-zero ' +
        '"dropped" means the buffer wrapped and that many events were lost after your cursor. ' +
        'Entries with truncated: true had their data clipped at 4 KB — re-fetch the full body with ' +
        'lol_get on the entry uri.',
      inputSchema: {
        since: z.number().int().min(0).optional().describe('cursor from the previous poll; omit to start at 0'),
        limit: z.number().int().min(1).max(500).optional().describe('max entries to return, default 100'),
        filter: z.string().optional().describe('extra URI prefix applied at poll time')
      }
    },
    guard(async ({ since = 0, limit = 100, filter = null }) => {
      const page = ctx.buffer.since(since, limit, filter);
      return ok({ ...page, running: ctx.tap.statusSnapshot().running });
    }, ctx)
  );

  server.registerTool(
    'lol_events_stop',
    {
      title: 'Stop buffering LCU events',
      description: 'Close the event tap. Buffered entries stay readable with lol_events_poll.',
      inputSchema: {}
    },
    guard(async () => {
      ctx.tap.stop();
      return ok({ stopped: true, buffered: ctx.buffer.length });
    }, ctx)
  );
}
```

- [ ] **Step 4: Register the tools**

In `src/index.js`, import `registerEventTools` and call it after `registerEndpointsTool`.

- [ ] **Step 5: Update the tool-name assertion**

In `tests/tools-status.test.js`, expect `['lol_endpoints', 'lol_events_poll', 'lol_events_start', 'lol_events_stop', 'lol_get', 'lol_request', 'lol_status']`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — including the 7 tests in `tests/tools-events.test.js`.

- [ ] **Step 7: Commit**

```bash
git add src/tools/events.js src/index.js tests/tools-events.test.js tests/tools-status.test.js
git commit -m "feat: event start/poll/stop tools"
```

---

### Task 16: `lol_dom_query` and `lol_eval`

**Files:**
- Create: `src/tools/dom.js`
- Modify: `src/index.js`, `tests/tools-status.test.js` (extend the expected list to the full nine names)
- Test: `tests/tools-dom.test.js`

**Interfaces:**
- Consumes: `ctx.cdp.domQuery/evaluate/statusSnapshot` (Task 10), `ctx.config.allowEval` (Task 1), `ok`/`fail`/`guard` (Task 12).
- Produces: `registerDomTools(server, ctx)` registering `lol_dom_query({ selector, all?, props? })` and `lol_eval({ expression, awaitPromise? })`.

`lol_eval` is refused with a clear message when `allowEval` is false. `lol_dom_query` is **not** gated — it injects the selector as data.

- [ ] **Step 1: Write the failing test**

`tests/tools-dom.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/index.js';
import { CdpUnavailableError } from '../src/cdp/discover.js';
import { fakeContext } from './helpers/context.js';

function cdpContext({ allowEval = true } = {}) {
  const calls = [];
  const base = fakeContext();
  const ctx = fakeContext({ config: { ...base.config, allowEval } });
  ctx.cdp = {
    statusSnapshot: base.cdp.statusSnapshot,
    domQuery: async (selector, options) => {
      calls.push({ kind: 'domQuery', selector, options });
      return [{ tag: 'BUTTON', text: 'Accept' }];
    },
    evaluate: async (expression, options) => {
      calls.push({ kind: 'evaluate', expression, options });
      return { phase: 'ReadyCheck' };
    }
  };
  return { ctx, calls };
}

async function connect(ctx) {
  const server = createServer(ctx);
  const client = new Client({ name: 'test', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);
  return client;
}

test('lol_dom_query forwards selector, all, and props', async () => {
  const { ctx, calls } = cdpContext();
  const client = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_dom_query',
    arguments: { selector: '.lol-uikit-flat-button', all: true, props: ['disabled'] }
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls[0], {
    kind: 'domQuery',
    selector: '.lol-uikit-flat-button',
    options: { all: true, props: ['disabled'] }
  });
  await client.close();
});

test('lol_dom_query works with allowEval off', async () => {
  const { ctx } = cdpContext({ allowEval: false });
  const client = await connect(ctx);
  const result = await client.callTool({ name: 'lol_dom_query', arguments: { selector: 'body' } });
  assert.equal(result.isError, undefined);
  await client.close();
});

test('lol_eval evaluates and returns the value', async () => {
  const { ctx, calls } = cdpContext();
  const client = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_eval',
    arguments: { expression: "fetch('/lol-gameflow/v1/session').then(r => r.json())", awaitPromise: true }
  });
  assert.deepEqual(JSON.parse(result.content[0].text), { value: { phase: 'ReadyCheck' } });
  assert.equal(calls[0].options.awaitPromise, true);
  await client.close();
});

test('lol_eval is refused when allowEval is false', async () => {
  const { ctx, calls } = cdpContext({ allowEval: false });
  const client = await connect(ctx);
  const result = await client.callTool({ name: 'lol_eval', arguments: { expression: '1 + 1' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /allowEval/);
  assert.equal(calls.length, 0, 'nothing is evaluated');
  await client.close();
});

test('a CDP outage surfaces the Pengu fix, not a socket error', async () => {
  const { ctx } = cdpContext();
  ctx.cdp.domQuery = async () => {
    throw new CdpUnavailableError(8888, 'ECONNREFUSED');
  };
  const client = await connect(ctx);
  const result = await client.callTool({ name: 'lol_dom_query', arguments: { selector: 'body' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /RemoteDebuggingPort/);
  await client.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/tools-dom.test.js`
Expected: FAIL — `Unknown tool: lol_dom_query`.

- [ ] **Step 3: Write the implementation**

`src/tools/dom.js`:

```js
import { z } from 'zod';
import { fail, guard, ok } from './result.js';

export function registerDomTools(server, ctx) {
  server.registerTool(
    'lol_dom_query',
    {
      title: 'Query the League client DOM',
      description:
        'Run document.querySelector(All) inside the client UI and return a description of the ' +
        'matches (tag, id, className, trimmed text, plus any requested properties). Needs Pengu ' +
        "Loader's remote debugging port; check lol_status if it fails.",
      inputSchema: {
        selector: z.string().min(1).describe('CSS selector, e.g. ".lol-uikit-flat-button"'),
        all: z.boolean().optional().describe('true returns every match, false (default) the first'),
        props: z
          .array(z.string())
          .optional()
          .describe('extra element properties or attributes to include, e.g. ["disabled", "href"]')
      }
    },
    guard(async ({ selector, all = false, props = [] }) => ok(await ctx.cdp.domQuery(selector, { all, props })), ctx)
  );

  server.registerTool(
    'lol_eval',
    {
      title: 'Evaluate JavaScript in the client page',
      description:
        "Evaluate an expression in the client UI's own context and return its value. Because the " +
        'page can fetch any LCU endpoint from its own origin, this bypasses the write allowlist by ' +
        'construction — it is gated by the allowEval config flag, whose state lol_status reports.',
      inputSchema: {
        expression: z.string().min(1).describe('a JavaScript expression, not a statement list'),
        awaitPromise: z.boolean().optional().describe('true to await a returned promise')
      }
    },
    guard(async ({ expression, awaitPromise = false }) => {
      if (!ctx.config.allowEval) {
        return fail(
          'lol_eval is disabled: "allowEval" is false in ' +
            `${ctx.config.configPath}. Set it to true to enable JS evaluation, or use lol_dom_query ` +
            'and lol_request instead.'
        );
      }
      return ok({ value: await ctx.cdp.evaluate(expression, { awaitPromise }) });
    }, ctx)
  );
}
```

- [ ] **Step 4: Register the tools**

In `src/index.js`, import `registerDomTools` and call it last inside `createServer`.

- [ ] **Step 5: Restore the full tool-name assertion**

In `tests/tools-status.test.js`, extend the expected list to the full nine names, sorted:

```js
  assert.deepEqual(names, [
    'lol_dom_query',
    'lol_endpoints',
    'lol_eval',
    'lol_events_poll',
    'lol_events_start',
    'lol_events_stop',
    'lol_get',
    'lol_request',
    'lol_status'
  ]);
```

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS — every suite, including the 5 tests in `tests/tools-dom.test.js` and the full nine-tool assertion.

- [ ] **Step 7: Commit**

```bash
git add src/tools/dom.js src/index.js tests/tools-dom.test.js tests/tools-status.test.js
git commit -m "feat: lol_dom_query and lol_eval with allowEval gate"
```

---

### Task 17: Live smoke script and README

**Files:**
- Create: `scripts/smoke.mjs`, `README.md`
- Test: none new — the smoke script *is* the live check and is never run in CI.

**Interfaces:**
- Consumes: everything built above, through the public exports.
- Produces: `npm run smoke`, exiting 0 when every stage passes and 1 with a per-stage report otherwise.

- [ ] **Step 1: Write the smoke script**

`scripts/smoke.mjs`:

```js
#!/usr/bin/env node
// Live end-to-end check. Requires a running League client; CDP stages also
// require Pengu Loader with RemoteDebuggingPort set. Never run in CI.
import { loadConfig } from '../src/config.js';
import { LcuClient } from '../src/lcu/client.js';
import { RingBuffer } from '../src/lcu/buffer.js';
import { LcuEventTap } from '../src/lcu/events.js';
import { CdpClient } from '../src/cdp/client.js';
import { probeVersion } from '../src/cdp/discover.js';

const results = [];
const record = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
    console.log(`FAIL ${name} — ${err.message}`);
  }
};

const config = loadConfig({});
const lcu = new LcuClient({});
const buffer = new RingBuffer(config.eventBufferSize);
const tap = new LcuEventTap({ client: lcu, buffer });
const cdp = new CdpClient({ port: config.cdpPort });

await record('lockfile', async () => {
  const creds = await lcu.credentials();
  return `port ${creds.port}, protocol ${creds.protocol}`; // never print the password
});

await record('REST GET /lol-gameflow/v1/gameflow-phase', async () => {
  const { status, body } = await lcu.get('/lol-gameflow/v1/gameflow-phase');
  if (status !== 200) throw new Error(`HTTP ${status}`);
  return `phase ${JSON.stringify(body)}`;
});

await record('WSS event tap', async () => {
  await tap.start(['/lol-gameflow/', '/lol-summoner/']);
  // Poke an endpoint that reliably emits, then wait briefly for a frame.
  await lcu.get('/lol-summoner/v1/current-summoner');
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const { entries } = buffer.since(0, 5);
  return `${entries.length} event(s), first uri ${entries[0]?.uri ?? 'none yet'}`;
});
tap.stop();

await record(`CDP /json/version on ${config.cdpPort}`, async () => {
  const version = await probeVersion(config.cdpPort);
  return `${version.Browser}, protocol ${version['Protocol-Version']}`;
});

await record('CDP Runtime.evaluate', async () => {
  const value = await cdp.evaluate('document.title');
  return `document.title = ${JSON.stringify(value)}`;
});

await record('CDP DOM query', async () => {
  const node = await cdp.domQuery('body');
  return `body class ${JSON.stringify(node?.className ?? null)}`;
});

await record('CDP page-context LCU fetch', async () => {
  const value = await cdp.evaluate(
    "fetch('/lol-summoner/v1/current-summoner').then(r => r.status)",
    { awaitPromise: true }
  );
  return `status ${value}`;
});

cdp.close();
lcu.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} stages passed`);
if (failed.length > 0) {
  console.log('If only the CDP stages failed, Pengu Loader is not active or RemoteDebuggingPort is unset.');
  process.exitCode = 1;
}
```

- [ ] **Step 2: Run the smoke script against the live client**

Run: `npm run smoke`
Expected: all 7 stages PASS with League running and Pengu active. If the CDP stages fail, apply the hint the script prints and rerun. If League is not running, this step cannot be completed — say so explicitly rather than marking it done.

- [ ] **Step 3: Write the README**

`README.md` must cover, in this order:

1. What it is — one paragraph, plus the pointer to `docs/superpowers/specs/2026-07-26-lcu-mcp-server-design.md`.
2. Requirements — Node >=24, a running League client, and Pengu Loader with `RemoteDebuggingPort=8888` for the DOM tools only.
3. Install — `npm install`.
4. Registering with Claude Code:

```bash
claude mcp add lcu --scope user -- node C:\\Users\\DELL\\Desktop\\lcu-mcp\\src\\index.js
```

   and the equivalent `.mcp.json` block:

```json
{
  "mcpServers": {
    "lcu": {
      "command": "node",
      "args": ["C:\\Users\\DELL\\Desktop\\lcu-mcp\\src\\index.js"],
      "env": { "LCU_MCP_CONFIG": "C:\\Users\\DELL\\Desktop\\lcu-mcp\\config\\allowlist.json" }
    }
  }
}
```

5. The nine tools — the table from the spec's "Tool surface" section.
6. Configuration — the `config/allowlist.json` shape, the exact matching rules (exact `METHOD path`, method case-insensitive, path case-sensitive, `*` only as a trailing segment, GET/HEAD always allowed), and `LCU_MCP_CONFIG`.
7. Enabling CDP — the Pengu config key, that the file is plain `key=value`, and the `POST /riotclient/kill-and-restart-ux` restart step.
8. Security — TLS verification is on with a pinned CA; the password is never returned or logged; `lol_eval` bypasses the write allowlist by construction and is gated by `allowEval`.
9. Testing — `npm test` (no client needed) and `npm run smoke` (live, manual).

- [ ] **Step 4: Verify the server starts as a real MCP process**

Run: `echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' | node src/index.js`
Expected: a single JSON-RPC response line advertising `serverInfo.name === "lcu-mcp"`. Nothing must be written to stdout except JSON-RPC — any stray `console.log` in stdio mode corrupts the protocol.

- [ ] **Step 5: Full verification**

Run: `npm test`
Expected: PASS, all suites, zero failures.

- [ ] **Step 6: Commit**

```bash
git add scripts/smoke.mjs README.md
git commit -m "feat: live smoke script and README"
```

---

## Self-Review Notes

Spec coverage check, section by section:

| Spec section | Task(s) |
|---|---|
| Architecture — two subsystems, lazy connect, restart survival | 5, 8, 10 |
| Package layout | File Structure table (two documented deviations) |
| Lockfile facts — port churn, directory watch, authoritative source | 4 |
| Event tap — subscribe frame, empty ack, frame shape | 7, 8 |
| CDP — Pengu requirement, single page target, redaction | 9, 10 |
| Tool surface — nine tools | 12–16 |
| Curated endpoints | 11, 14 |
| Events — ring buffer, cursor, dropped, ingest filters, 4 KB truncation, restart semantics | 6, 7, 8, 15 |
| Configuration — file, `LCU_MCP_CONFIG`, matching rules, denial message | 1, 2, 13 |
| Lifecycle — backoff 1s→30s, reconnect marker, CDP retry-once | 8, 10 |
| Security — pinned CA, redaction, `allowEval` gate | 5, 3, 16 |
| Testing — the five unit-test areas plus `scripts/smoke.mjs` | 1–11, 17 |

Known open items, deliberately left to execution time:
- `certs/riotgames.pem` must be fetched (Task 5 Step 1). If the URL has moved, take the PEM from the client install; do not weaken TLS.
- Task 5 Step 6, Task 17 Steps 2 and 4 need a running client. If it is not running, report them as not verified rather than done.
