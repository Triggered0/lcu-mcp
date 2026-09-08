# Phase 1: UX Restart Tool (`lol_restart_ux`) & Dynamic CDP Port Discovery

## Goal

Provide zero-configuration developer ergonomics when inspecting the League of Legends Client and developing Pengu Loader plugins:

1. **Zero-Configuration CDP Port Discovery**: Eliminate hardcoded CDP port assumptions (`cdpPort: 8888`). Automatically resolve the active DevTools port from Pengu Loader configuration or running `LeagueClientUxRender.exe` processes without requiring manual config edits.
2. **First-Class UX Restart Tool (`lol_restart_ux`)**: Expose a dedicated MCP tool to safely terminate and restart the frontend Chromium Embedded Framework (CEF) renderers via Riot's `POST /riotclient/kill-and-restart-ux`, with built-in readiness polling for both the LCU HTTP API and the CDP page target.

## Non-goals

Deferred to subsequent phases:
- CDP target selection and multi-target listing (`lol_cdp_targets` - Phase 2).
- Taking screenshots of the client UI (`lol_cdp_screenshot` - Phase 2).
- OpenAPI/Swagger introspection (`lol_schema` - Phase 3).
- Correlating WAMP and CDP console logs (`lol_forensics_correlate` - Phase 4).

## Locked Decisions

| Decision | Rationale |
|---|---|
| Priority hierarchy for port resolution | Explicit user config (`config.cdpPort` integer or `LCU_CDP_PORT` env) > Pengu config file > Process command line argument > fallback (8888). User overrides must always win, file read is 0ms overhead, process scan is fallback. |
| Dynamic port resolution in `CdpClient` | CdpClient accepts either a static port or a dynamic resolver function. When reconnecting after a UX restart, it re-queries the resolver in case the port changed. |
| `lol_restart_ux` is a first-class MCP tool | Rebuilding/restarting UX is a safe developer operation. It does not require user configuration in `writeAllowlist`. |
| Clean socket close before triggering restart | When `LeagueClientUxRender.exe` dies, open WebSockets receive abrupt disconnects (`ECONNRESET`). Closing `CdpClient` and resetting `ConsoleTailer` proactively avoids spurious error cascades. |
| Readiness criteria includes both LCU and CDP | When `waitForReady: true` (default), the tool polls until the LCU HTTP API responds (`/riotclient/region-locale` 200 OK) AND the frontend CEF page target appears in `/json/list`. |
| Graceful toleration of UX kill connection drop | Riot's UX kill endpoint frequently drops the TCP socket immediately (`ECONNRESET` / socket hang up). This is treated as a successful trigger rather than a failure. |

## Architecture & Components

```
                    ┌───────────────────────────────┐
                    │        lol_restart_ux()       │
                    └───────────────┬───────────────┘
                                    │
                    1. Close active CDP connections
                    2. POST /riotclient/kill-and-restart-ux
                                    │
                       waitForReady === true?
                       ┌────────────┴────────────┐
                    No │                         │ Yes
                       ▼                         ▼
            { restarted: true,          3. 1.5s initial cooldown
              waiting: false }          4. Poll LCU API (HTTP 200)
                                        5. Poll CDP findPageTarget()
                                                 │
                                                 ▼
                                        { success: true,
                                          durationMs: 4200,
                                          cdpPort: 8888,
                                          targetTitle: "League of Legends" }
```

### 1. Dynamic CDP Port Discovery (`src/cdp/discover.js`)

#### Port Resolution Algorithm:
`resolveCdpPort({ config, env = process.env, forceRefresh = false, readConfigFile = readPenguConfig, scanProcesses = findProcessCdpPort })`:

1. **Explicit Override**:
   - If `env.LCU_CDP_PORT` is set, parse as integer.
   - If `config?.cdpPort` is an integer (and not `'auto'`), return it.
2. **Pengu Loader Config File**:
   - Check `env.PENGU_CONFIG_PATH` or `C:\Program Files\Pengu Loader\config`.
   - Asynchronously read file contents. Extract value from regex `/^RemoteDebuggingPort\s*=\s*(\d+)/m`.
   - If a valid port (1-65535) is found, cache and return it with source `'pengu-config'`.
3. **Running Process Command Line Inspection**:
   - Only on Windows (`process.platform === 'win32'`).
   - Query running `LeagueClientUxRender.exe` command lines (e.g. via PowerShell `Get-CimInstance Win32_Process`).
   - Extract `--remote-debugging-port=(\d+)`.
   - If found, cache and return it with source `'process'`.
4. **Fallback Default**:
   - Return port `8888` with source `'fallback'`.
5. **Caching & Invalidation**:
   - Resolved port is cached in module state for instant subsequent calls.
   - Calling with `forceRefresh: true` clears the cache and repeats resolution.

### 2. `CdpClient` Integration (`src/cdp/client.js`)

- `CdpClient` constructor accepts `portResolver?: () => Promise<number>` or `port?: number`.
- Before connecting in `#connect()`, it calls `await this.#resolvePort()`.
- Method `getPort()` returns the resolved or configured port.
- Method `statusSnapshot()` includes `port` and `targetId`.

### 3. Dedicated UX Lifecycle Tool: `lol_restart_ux` (`src/tools/ux.js`)

- Registered on `McpServer` with description:
  `"Restart the League Client UX (frontend CEF renderers). Essential when developing Pengu Loader plugins or recovering from a frozen interface."`
- **Input Schema**:
  ```ts
  {
    waitForReady: z.boolean().default(true)
      .describe("Wait until both LCU HTTP API and CDP page target are fully responsive after restart"),
    timeoutSeconds: z.number().int().min(5).max(60).default(20)
      .describe("Maximum seconds to wait for UX readiness when waitForReady is true")
  }
  ```
- **Execution Lifecycle**:
  1. Call `ctx.cdp.close()` and `ctx.consoleTailer.stop()` / disconnect to silence stale socket drops.
  2. Invoke `POST /riotclient/kill-and-restart-ux`. Catch `ECONNRESET` or socket hang-up and treat as successful dispatch.
  3. If `waitForReady === false`, return immediately:
     `{ success: true, restarted: true, waiting: false, message: "Restart command sent to Riot Client UX" }`.
  4. If `waitForReady === true`:
     - Initial cooldown sleep of 1500ms to allow old processes to terminate.
     - Deadline = `Date.now() + timeoutSeconds * 1000`.
     - Polling loop (interval 500ms):
       - Step A: Verify LCU API with `ctx.lcu.get('/riotclient/region-locale')`. If success, `lcuReady = true`.
       - Step B: If `lcuReady`, force-refresh CDP port resolver (`forceRefresh: true`) and call `findPageTarget(resolvedPort)`. If page target found, `cdpReady = true`.
       - Step C: If both ready, break loop and return:
         `{ success: true, durationMs, lcuReady: true, cdpReady: true, cdpPort, targetTitle, message: "League Client UX restarted and fully responsive" }`.
     - If deadline expires before both ready:
       Return `fail({ message: `Timed out waiting for UX readiness after ${timeoutSeconds}s`, partial: { lcuReady, cdpReady }, durationMs })`.

### 4. Configuration Updates (`src/config.js`)

- `DEFAULTS.cdpPort = 'auto'`.
- In `validateConfig(raw)`:
  - Allow `config.cdpPort === 'auto'` or integer `1 <= cdpPort <= 65535`.
- In `src/tools/status.js`:
  - Include `cdpPort` and `portSource` in the returned snapshot.

## Error Handling & Edge Cases

1. **Abrupt Socket Closure on UX Kill**:
   Riot Client terminates the UX immediately upon receiving the POST request. The HTTP agent may encounter `ECONNRESET` or socket hang up. The tool treats this network exception as confirmation of termination rather than failure.
2. **Missing or Corrupted Pengu Config**:
   If the config file does not exist (`ENOENT`) or lacks the expected key, it quietly falls back to process scanning without throwing.
3. **Process Scan Failure on Non-Windows / Restricted Environments**:
   If PowerShell command fails or is unavailable, it gracefully defaults to 8888.
4. **Timeout During Readiness Polling**:
   Detailed partial state is returned so the caller knows whether LCU failed to come back up, or LCU came up but CDP failed to initialize.

## Testing Strategy

### Unit Tests
1. `tests/cdp/discover.test.js`:
   - `readPenguConfig`: reads valid `RemoteDebuggingPort=8888`, handles non-existent file, handles file without the key, trims whitespace.
   - `findProcessCdpPort`: parses command-line with `--remote-debugging-port=9222`, handles process without flag, handles empty process list.
   - `resolveCdpPort`: verifies priority order (explicit override > pengu file > process scan > fallback 8888); verifies cache invalidation on `forceRefresh: true`.
2. `tests/tools/ux.test.js`:
   - `lol_restart_ux`:
     - Dispatches `POST /riotclient/kill-and-restart-ux`.
     - Handles `ECONNRESET` cleanly.
     - With `waitForReady: false`, returns immediately.
     - With `waitForReady: true`, polls mock LCU client and mock `findPageTarget` until ready.
     - Fails cleanly on timeout with partial status report.
3. Regression Verification:
   - Full `npm test` suite passes cleanly.
