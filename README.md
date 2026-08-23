# lcu-mcp

A stdio MCP server that exposes a running League of Legends client to an MCP
host: the LCU REST API, its `OnJsonApiEvent` stream, and the client UI's own
CEF DOM/JS context — nine tools over one Node process. Two subsystems run side
by side: `LcuClient` (lockfile discovery, TLS-pinned REST, WSS event tap into a
ring buffer) and `CdpClient` (Pengu Loader's remote debugging port,
`Runtime.evaluate`, DOM queries). Both lazy-connect and survive client restarts.

Design rationale and the live-verified protocol details:
[`docs/superpowers/specs/2026-07-26-lcu-mcp-server-design.md`](docs/superpowers/specs/2026-07-26-lcu-mcp-server-design.md).

## Requirements

- Node >= 24 (ESM, no build step).
- A running League of Legends client — the lockfile at
  `C:\Riot Games\League of Legends\lockfile` is what supplies the port and password.
- **DOM tools only:** [Pengu Loader](https://pengu.lol) active with
  `RemoteDebuggingPort=8888`. Everything else works without it.

## Install

```bash
npm install
```

No runtime dependencies beyond `@modelcontextprotocol/sdk`, `zod`, and `ws`.

## Registering with Claude Code

```bash
claude mcp add lcu --scope user -- node C:\Users\DELL\Desktop\lcu-mcp\src\index.js
```

The equivalent `.mcp.json` block:

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

## Tools

| Tool | Purpose |
|---|---|
| `lol_status` | Per-subsystem health, resolved LCU port, configured CDP port, whether `allowEval` is on |
| `lol_get(path)` | GET any LCU path |
| `lol_request(method, path, body?)` | Any verb, subject to the write allowlist |
| `lol_endpoints(filter?)` | List the curated endpoint table |
| `lol_events_start(filters?)` | Open the WSS tap and begin buffering |
| `lol_events_poll(since?, limit?, filter?)` | Drain the ring buffer |
| `lol_events_stop()` | Close the tap |
| `lol_dom_query(selector, all?, props?)` | Query the client DOM |
| `lol_eval(expression, awaitPromise?)` | Evaluate JS in the page |

`lol_status` is the first thing to call when anything else fails: it separates
an LCU outage (client closed) from a CDP one (Pengu not loaded).

Events are polled, not pushed — MCP has no server-push. `lol_events_poll`
returns a `cursor`; pass it back as `since` on the next call. A non-zero
`dropped` means the ring buffer wrapped and that many events were lost after
your cursor. Entries with `truncated: true` had their `data` clipped at 4 KB;
re-fetch the full body with `lol_get` on the entry's `uri`.

## Configuration

`config/allowlist.json`:

```json
{
  "allowEval": true,
  "cdpPort": 8888,
  "eventBufferSize": 1000,
  "writeAllowlist": [
    "POST /lol-matchmaking/v1/ready-check/accept",
    "PATCH /lol-champ-select/v1/session/actions/*"
  ]
}
```

Set `LCU_MCP_CONFIG` to point elsewhere; with no config file at all, the
defaults above apply with an empty `writeAllowlist`. Matching rules:

- An entry is `METHOD path`. The method is compared case-insensitively, the
  path **case-sensitively**.
- `GET` and `HEAD` are always allowed and need no entry.
- `*` is only meaningful as a trailing path segment: `/a/b/*` matches `/a/b/c`
  but not `/a/b/c/d` and not `/a/b`. Anywhere else it is a literal character.
- A refused call returns the exact config line that would permit it, and the
  request is never sent.

## Enabling CDP (DOM tools)

Pengu Loader's config is plain `key=value` text, one pair per line — not JSON,
not INI. In `C:\Program Files\Pengu Loader\config`, set:

```
RemoteDebuggingPort=8888
```

Then restart the client UX so CEF picks the port up:

```
POST /riotclient/kill-and-restart-ux
```

Until that happens, `lol_dom_query` and `lol_eval` fail with this exact fix in
the error message rather than a bare `ECONNREFUSED`.

## Security

- TLS verification stays **on**. The LCU's self-signed certificate is validated
  against Riot's root CA, vendored at `certs/riotgames.pem` — the server never
  sets `rejectUnauthorized: false`.
- The lockfile password is never returned by a tool and never logged. It is
  held only to build the `Authorization` header, and error text is scrubbed of
  it before it reaches the host.
- `lol_eval` bypasses the write allowlist **by construction**: the client page
  can `fetch` any LCU endpoint from its own origin. It is gated by the
  `allowEval` config flag, whose state `lol_status` reports. Set `allowEval` to
  `false` to disable it; `lol_dom_query` keeps working, because it injects the
  selector as data rather than as code.

## Testing

```bash
npm test        # unit tests, node:test — no League client needed
npm run smoke   # live end-to-end check, requires a running client (and Pengu for the CDP stages)
```

`npm run smoke` prints one line per stage and exits 1 if any stage fails. It is
never run in CI.
