# LCU MCP Server — Design

Date: 2026-07-26
Status: Design approved. Ready for implementation planning.

## Goal

An MCP server that lets Claude inspect and drive a running League client while
developing client-automation modules — read live LCU state, watch client events,
and query the client's DOM — instead of guessing at endpoint shapes and
selectors.

## Locked decisions

| Question | Decision |
|---|---|
| Purpose | Dev tool for this repo, not a user-facing product |
| Tool surface | Generic passthrough core **plus** curated tools for the endpoints client-automation uses |
| Write policy | GET always allowed; mutating verbs only on a config allowlist, everything else refused with a clear message |
| Location | Separate repo at `C:\Users\DELL\Desktop\lcu-mcp` |
| Runtime | Node + `@modelcontextprotocol/sdk` |
| DOM access | LCU **and** CDP from the start, not a follow-up phase |
| Architecture | Approach A — one server, two subsystems |
| Distribution | Personal use; not published to npm |

## Architecture

Single Node package, stdio transport. Two subsystems inside one process:

- **`LcuClient`** — watches the lockfile, derives port + Basic auth
  (`riot:<password>`), verifies TLS against Riot's pinned root CA; does REST
  calls and holds a WSS tap for `OnJsonApiEvent`.
- **`CdpClient`** — probes the CEF remote-debugging port via `/json/version`,
  attaches to the LeagueClientUx page target; DOM queries and JS evaluation.

Both lazy-connect and survive client restarts. A `lol_status` tool reports
per-subsystem health so a CDP outage is distinguishable from an LCU one.
Events land in an in-process ring buffer, drained by a polling tool — MCP has no
server-push, and session-scoped buffering matches the actual use case ("run a
game, then tell me what fired").

Rejected: **B** (two separate servers) — clean isolation, but duplicated
discovery code and no shared correlation between an event and a DOM state.
**C** (background daemon + thin MCP client) — better event fidelity across
sessions, but a process lifecycle to manage; only pays off for unattended
capture.

## Package layout

```
lcu-mcp/
  src/
    index.js          # stdio transport, tool registration, nothing else
    lcu/
      lockfile.js     # find + parse + watch lockfile -> {port, password, protocol}
      client.js       # REST: request(method, path, body) -> {status, body}
      events.js       # WSS tap, OnJsonApiEvent -> ring buffer
    cdp/
      discover.js     # probe /json/version + /json/list, pick target
      client.js       # attach, Runtime.evaluate / DOM queries
    tools/
      passthrough.js  # lol_get, lol_request
      curated.js      # generated from an endpoint table
      events.js       # lol_events_poll
      dom.js          # lol_dom_query, lol_eval
      status.js       # lol_status
    config.js         # load + validate allowlist config
  config/
    allowlist.json
  scripts/
    smoke.mjs         # manual live check, requires a running client
```

## Phase 0 spike — complete

Everything below was verified live against a running client on 2026-07-26. The
Pengu-side WebSocket bridge fallback named in the earlier draft is **dropped**;
it is not needed.

### LCU

- Lockfile: `C:\Riot Games\League of Legends\lockfile`, format
  `name:pid:port:password:protocol`.
- The port changes on every client launch (observed 1527, 53763, 29669). A
  UX-only restart keeps the port and password.
- The lockfile port is owned by `LeagueClient.exe`. `LeagueClientUx.exe` listens
  on **zero** ports, so process-handle port discovery picks the wrong process —
  the lockfile is the only authoritative source.
- The file is deleted and recreated on restart, so the **directory** must be
  watched, not the file.
- REST verified: `GET /lol-gameflow/v1/gameflow-phase` → `ReadyCheck`, later
  `InProgress`.
- Event tap verified: connect `wss://riot:<password>@127.0.0.1:<port>/`, send
  `[5,"OnJsonApiEvent"]`. Events arrive as
  `[8,"OnJsonApiEvent",{eventType,uri,data}]`. **The subscribe ack arrives as an
  empty frame** — parsing it as JSON throws, so empty frames must be skipped.

### CDP

CDP is reachable only through Pengu Loader. Riot's CEF build ignores an
externally added `--remote-debugging-port` (verified: the flag was present on
the process and no port opened). Pengu appends the switch from inside its
`OnBeforeCommandLineProcessing` hook, which runs early enough to take effect.

Enabling it: `C:\Program Files\Pengu Loader\config` is plain `key=value` text,
one pair per line — not JSON, not INI. Set `RemoteDebuggingPort=8888`. There is
no GUI option for this. In Pengu 1.1.6 the key names differ from those on the
project's `main` branch; `RemoteDebuggingPort` is the 1.1.6 spelling. Applying a
config change needs a UX restart: `POST /riotclient/kill-and-restart-ux`, which
leaves a live `League of Legends.exe` game untouched.

Verified on port 8888: `/json/version` → CEF 108, protocol 1.3. `/json/list`
returns exactly one `page` target. `Runtime.evaluate`, `DOM.getDocument`, and
`DOM.querySelectorAll` all work, and page-context
`fetch('/lol-summoner/v1/current-summoner')` returns 200.

Two consequences carried into the design:

- The `/json/list` target URL embeds the LCU password
  (`https://riot:<password>@127.0.0.1:<port>/index.html`). **Target URLs must be
  redacted before any tool returns them.**
- Because evaluated JS can `fetch` any LCU endpoint from the page's own origin,
  `lol_eval` bypasses the write allowlist by construction. This is accepted, not
  fixed — see Security.

CDP availability is therefore a property of the Pengu install, not of the League
client. `lol_status` must say "CDP unavailable: Pengu Loader not active or
RemoteDebuggingPort unset" rather than surfacing a bare connection error.

## Tool surface

Nine tools. The "curated tools" decision is realised as **data**: the endpoint
table lives in `tools/curated.js` and is surfaced through `lol_endpoints`, so
the curation is discoverable without registering 40+ separate tools that would
crowd the tool list.

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

### Curated endpoints

Derived from endpoints the client-automation modules actually call:

- `/lol-gameflow/v1/gameflow-phase`, `/lol-gameflow/v1/session`
- `/lol-champ-select/v1/session`, `/session/actions/{id}`,
  `/bannable-champion-ids`, `/pickable-champion-ids`
- `/lol-summoner/v1/current-summoner`, `/v1/summoners/{id}`,
  `/v2/summoners/puuid/{puuid}`, `/v1/summoners/aliases`, `/v1/alias/lookup`
- `/lol-lobby/v2/lobby`, `/lobby/matchmaking/search`, `/play-again`,
  `/notifications`, `/lobby/invitations`
- `/lol-matchmaking/v1/ready-check`, `/ready-check/accept`
- `/lol-end-of-game/v1/eog-stats-block`, `/lol-honor/v1/honor`, `/v1/ballot`
- `/lol-chat/v1/me`, `/v1/friends`, `/v1/friend-groups`, `/v1/conversations`
- `/lol-ranked/v1/ranked-stats/{puuid}`, `/lol-match-history/v1/*`
- `/lol-challenges/v1/*`, `/lol-settings/v1/local/video`,
  `/lol-champions/v1/inventories/{id}/*`, `/lol-loot/v1/player-loot`,
  `/lol-inventory/v2/*`, `/lol-catalog/v1/items/EMOTE`
- `/riotclient/region-locale`

## Events

Ring buffer, default 1000 entries, oldest dropped on overflow. Each entry:

```js
{ seq, ts, eventType, uri, data, truncated }
```

`lol_events_poll(since)` returns entries with `seq > since`, the new cursor, and
a `dropped` count whenever the buffer wrapped since the last poll.

Filters are URI prefix strings (`/lol-champ-select/`) applied **at ingest**, not
at poll time — the unfiltered `Create/Update/Delete` firehose fills 1000 slots
quickly and would evict everything of interest. `data` is truncated per entry at
4 KB with `truncated: true`; the full body is fetched with `lol_get` on the
entry's `uri`.

Calling `lol_events_start` while the tap is already running replaces the active
filters and keeps the existing buffer contents; it is not an error. Filters
therefore apply only to events arriving after the call.

## Configuration

`config/allowlist.json`, path overridable by the `LCU_MCP_CONFIG` environment
variable.

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

Matching is exact `METHOD path`. Method comparison is case-insensitive; path
comparison is case-sensitive. `*` is permitted only as a trailing path segment
(`POST /lol-champ-select/v1/session/actions/*`). GET and HEAD are always
allowed and need no entry.

A denied write returns the exact allowlist line that would permit it, so it can
be pasted into the config:

> `POST /lol-lobby/v2/lobby` is not on the write allowlist. To permit it, add
> `"POST /lol-lobby/v2/lobby"` to `writeAllowlist` in `config/allowlist.json`.

Write-allowlist candidates, needed to reproduce flows: ready-check accept,
matchmaking search start/stop, champ-select actions, play-again. Chat sends and
account-settings writes stay off the default allowlist.

## Lifecycle and error handling

Both subsystems connect lazily on first use and cache the connection.

**LCU.** The lockfile's directory is watched. On change, REST re-reads the
credentials and the event socket reconnects with backoff from 1s to 30s,
replaying its subscriptions and writing a `reconnected` marker into the ring
buffer so a gap in the event stream is visible rather than silent.

**CDP.** Discovery selects the single `page` target from `/json/list`. If an
attach fails, discovery re-runs once before reporting an error.

Every tool error is a structured message naming the subsystem and the fix. A
refused CDP connection reports that Pengu is not active or the port is unset;
it never surfaces a bare `ECONNREFUSED`.

## Security

- **TLS.** The LCU's certificate is issued by Riot's own CA, and Riot publishes
  that root (`riotgames.pem`). The client pins it via the `ca:` option so
  verification stays **on**. Verified live: the served cert is `CN=rclient`,
  issued by `LoL Game Engineering Certificate Authority`, with
  `SAN: DNS:localhost, IP:127.0.0.1` — so pinning the CA alone passes both chain
  and hostname verification against `127.0.0.1`. No `checkServerIdentity`
  override and no disabled verification anywhere. The process-global
  `NODE_TLS_REJECT_UNAUTHORIZED=0` used during the spike is not used in the
  implementation — it would weaken every connection the process makes. Node 24's
  global `WebSocket` has no per-socket TLS option, so the `ws` package is used
  for the event tap and a scoped `https.Agent` for REST.
- **Credential redaction.** The LCU password appears in the lockfile and in CDP
  target URLs. It is never logged and never returned by a tool; target URLs are
  redacted at the boundary.
- **`lol_eval`.** Gated by the `allowEval` config flag (default on) and its
  state is reported by `lol_status`. Evaluated JS runs in the client's own
  origin and can `fetch` any LCU endpoint, so enabling it effectively disables
  the write allowlist. That trade-off is intentional for a local dev tool;
  turning `allowEval` off restores the allowlist as the only write path.

## Testing

Unit tests cover pure logic and run with no client present:

- lockfile parsing — valid, malformed, missing, trailing newline
- allowlist matching — allow, deny, trailing wildcard, method case-insensitivity
- ring buffer — wrap, cursor arithmetic, `dropped` accounting
- event filter matching — prefix hit and miss
- redaction — password stripped from target URLs and error strings

`scripts/smoke.mjs` is the Phase 0 probe kept as a live check: lockfile → REST
→ WSS tap → CDP evaluate → DOM query. It requires a running client with Pengu
active and is run by hand, never in CI.
