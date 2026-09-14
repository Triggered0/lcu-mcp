# lcu-mcp

[![M8ven Score](https://m8ven.ai/badge/mcp/triggered0-lcu-mcp-191f9c?v=03198e76a2bc3a2c1b46a23e5a077b81)](https://m8ven.ai/mcp/triggered0-lcu-mcp-191f9c)
[![npm version](https://img.shields.io/npm/v/lcu-mcp.svg)](https://www.npmjs.com/package/lcu-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](https://nodejs.org)
[![CI](https://github.com/Triggered0/lcu-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Triggered0/lcu-mcp/actions/workflows/ci.yml)

An [MCP](https://modelcontextprotocol.io) server that exposes a running League of Legends client to any MCP host — the LCU REST API, live WAMP events & recording, client DOM and CDP console, and OpenAPI schema introspection over stdio.

Ask your assistant what queue you are in, watch champ select unfold event by event, inspect the client's DOM, or drive the client itself — without writing a line of glue code.

## Contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Installation](#installation)
- [Registering with an MCP host](#registering-with-an-mcp-host)
- [Quick start](#quick-start)
- [Tools](#tools)
- [Configuration](#configuration)
- [Enabling DOM access](#enabling-dom-access)
- [Security](#security)
- [Development](#development)
- [Contributing](#contributing)
- [Troubleshooting](#troubleshooting)
- [Privacy](#privacy)
- [Disclaimer](#disclaimer)
- [License](#license)

## How it works

Two independent subsystems run inside one Node process:

- **`LcuClient`** reads the client's lockfile to discover the port and password, then talks REST over HTTPS with Riot's root CA pinned, and holds a WebSocket tap on `OnJsonApiEvent` that feeds an in-process ring buffer.
- **`CdpClient`** attaches to the client's Chrome DevTools Protocol endpoint (exposed by [Pengu Loader](https://pengu.lol)) for DOM queries and JavaScript evaluation.

Both connect lazily and survive client restarts — the lockfile port changes on every launch, so the directory is watched rather than the file. Events are polled rather than pushed, because MCP has no server-to-client push.

## Requirements

| | |
|---|---|
| **Node.js** | >= 24 (ESM, no build step) |
| **League of Legends** | Running. The lockfile at `C:\Riot Games\League of Legends\lockfile` supplies the port and password. |
| **Pengu Loader** | Optional — required **only** for `lol_dom_query` and `lol_eval`. Everything else works without it. |

Windows only in practice: the default lockfile path and the Pengu integration are Windows-specific.

## Installation

### Via `npx` (Recommended, zero install)

Run directly with `npx`:

```bash
npx -y lcu-mcp
```

### From source

```bash
git clone https://github.com/Triggered0/lcu-mcp.git
cd lcu-mcp
npm install
```

Runtime dependencies are exactly three: `@modelcontextprotocol/sdk`, `zod`, and `ws`.

## Registering with an MCP host

### Claude Code

```bash
# Recommended: via npx
claude mcp add lcu --scope user -- npx -y lcu-mcp

# Or from a local clone:
claude mcp add lcu --scope user -- node C:\path\to\lcu-mcp\src\index.js
```

### Any host that reads `.mcp.json`

```json
{
  "mcpServers": {
    "lcu": {
      "command": "npx",
      "args": ["-y", "lcu-mcp"]
    }
  }
}
```

Or from a local repository clone:

```json
{
  "mcpServers": {
    "lcu": {
      "command": "node",
      "args": ["C:\\path\\to\\lcu-mcp\\src\\index.js"],
      "env": { "LCU_MCP_CONFIG": "C:\\path\\to\\lcu-mcp\\config\\allowlist.json" }
    }
  }
}
```

`LCU_MCP_CONFIG` is optional; without it the server looks for `config/allowlist.json` relative to its working directory, and falls back to built-in defaults if that file does not exist.

## Quick start

Start the League client, then ask your assistant in plain language. A few things that work with no further setup:

| Ask | What runs |
|---|---|
| *"Is the LCU connection healthy?"* | `lol_status` |
| *"Who am I logged in as?"* | `lol_get("/lol-summoner/v1/current-summoner")` |
| *"What am I doing in the client right now?"* | `lol_get("/lol-gameflow/v1/gameflow-phase")` |
| *"Which champion is id 157?"* | `lol_static(kind="champions", ids=[157])` |
| *"Watch champ select and tell me what happens."* | `lol_events_start(["/lol-champ-select/"])`, then `lol_events_poll` |
| *"What does the lobby endpoint accept?"* | `lol_schema("/lol-lobby/v2/lobby")` |
| *"Accept the ready check."* | `lol_request("POST", "/lol-matchmaking/v1/ready-check/accept")` — needs a [write allowlist](#configuration) entry |
| *"Screenshot the client."* | `lol_cdp_screenshot` — needs [Pengu Loader](#enabling-dom-access) |

Nothing here needs a Riot API key or an internet connection: every call goes to `127.0.0.1`.

## Tools

| Tool | Purpose |
|---|---|
| `lol_status` | Per-subsystem health, resolved LCU port, configured CDP port, whether `allowEval` is on |
| `lol_get(path)` | GET any LCU path |
| `lol_request(method, path, body?)` | Any verb, subject to the write allowlist |
| `lol_endpoints(filter?)` | List the curated endpoint table |
| `lol_static(kind, ids?, query?, fields?, limit?, offset?, refresh?)` | Resolve champion/item/perk/spell/map/queue ids to names from the client's local game data |
| `lol_events_start(filters?)` | Open the WebSocket tap and begin buffering |
| `lol_events_poll(since?, limit?, filter?)` | Drain the ring buffer |
| `lol_events_stop()` | Close the tap |
| `lol_dom_query(selector, all?, props?)` | Query the client DOM |
| `lol_eval(expression, awaitPromise?)` | Evaluate JavaScript in the page |
| `lol_wamp_record_start(uris?, restart?)` | Record LCU WAMP traffic on an independent socket |
| `lol_wamp_record_dump(uri?, since?, until?, kinds?, limit?, cursor?)` | Dump the recorded timeline and per-URI stats |
| `lol_wamp_record_stop()` | Close the recorder socket |
| `lol_cdp_console_start()` | Begin buffering client console output |
| `lol_cdp_console_tail(since?, until?, cursor?, limit?, level?, targetId?, text?)` | Read buffered console entries |
| `lol_cdp_console_stop()` | Stop and discard the console buffer |
| `lol_cdp_network_start()` | Begin buffering the HTTP requests the client UI makes |
| `lol_cdp_network_tail(since?, until?, cursor?, limit?, urlContains?, method?, status?, minStatus?, type?, failedOnly?, targetId?)` | Read buffered requests |
| `lol_cdp_network_body(requestId)` | Fetch one response body from the live renderer |
| `lol_cdp_network_summary(since?, until?, urlContains?, method?)` | Aggregate requests by method and url |
| `lol_cdp_network_stop()` | Stop and discard the request buffer |
| `lol_logs_tail(target?, lines?, session?, level?, search?)` | Tail the most recent lines of a client, UX, or game log |
| `lol_logs_watch_start(target?)` | Begin streaming newly appended log lines into a ring buffer |
| `lol_logs_watch_poll(cursor?, limit?, level?, search?)` | Poll newly streamed log entries |
| `lol_logs_watch_stop()` | Stop and discard the log watcher buffer |
| `lol_logs_sessions(target?, limit?)` | List active and historical log files on disk |
| `lol_restart_ux(waitForReady?, timeoutSeconds?)` | Safely restart client CEF renderers with readiness polling |
| `lol_cdp_targets()` | List all active CDP debugging targets (pages, popups, workers) |
| `lol_cdp_screenshot(targetId?, format?, quality?, savePath?)` | Capture client screenshot via CDP (returns MCP image + disk save) |
| `lol_schema(path?, method?, model?, refresh?)` | Query internal LCU OpenAPI/Swagger v2 schemas and models |
| `lol_forensics_correlate(since?, until?, limit?, uriPrefix?, levels?, format?)` | Correlate WAMP recorder and CDP console timelines on a shared time axis |

**`lol_status` first.** When anything else fails it tells you which half is down — a closed client looks nothing like a missing Pengu install.

**Ids come back raw.** Champ select, the gameflow, and match history all speak in numbers — `championId: 157`, `perk: 8008`, `queueId: 420`. `lol_static` resolves them to `Yasuo`, `Lethal Tempo`, and `Ranked Solo/Duo` from documents the client already serves locally, so no Data Dragon, no API key, and no call leaves `127.0.0.1`. It projects to `{id, name}` and pages at 50 entries by default — `items` alone is 868 entries and 667 KB raw — so widen it deliberately with `fields`, `limit`, and `offset`.

**Events are polled.** `lol_events_poll` returns a `cursor`; pass it back as `since` next time. A non-zero `dropped` means the ring buffer wrapped and that many events were lost after your cursor. Entries with `truncated: true` had their `data` clipped at 4 KB — re-fetch the full body with `lol_get` on the entry's `uri`.

**The client only emits when state changes.** Sitting idle on the home screen it can stay silent indefinitely; navigating the UI or entering a lobby produces bursts. An empty poll usually means nothing happened, not that the tap is broken — check `running` and `lol_status` to tell the two apart.

**Diagnosing a missing event.** `lol_wamp_record_*` runs on its own WAMP socket
outside the client renderer, so it proves what the LCU actually emitted and
when. Read it together with `lol_cdp_console_tail` and a `lol_eval` probe to
separate three cases: the LCU never emitted, it emitted but the page never
received, or the page received and mishandled. Start both recorders *before*
the thing you want to observe — they only hold what arrived after they started.

**Three views, one story.** `lol_wamp_record_*` shows what the LCU pushed,
`lol_cdp_console_*` shows what the page said, and `lol_cdp_network_*` shows what
the page asked for. Each entry names the code that issued the request, so "why
did the client call this" has an answer rather than a guess. A 404 arrives as an
ordinary response, not a transport failure — reach for `minStatus: 400` when you
want everything that went wrong, and `failedOnly` only for connections that never
completed. Response bodies are fetched on demand with `lol_cdp_network_body`, not
buffered.

**Disk logs for historical and game-engine forensics.** `lol_logs_tail` and
`lol_logs_sessions` inspect `LeagueClient.log`, `LeagueClientUx.log`, and `GameLogs`
(`r3dlog.txt`) directly on disk without requiring an active WebSocket or Pengu debugger.
For live monitoring across client actions, `lol_logs_watch_start` streams newly appended
lines from EOF into a dedicated ring buffer. All lines undergo ingest-time credential
scrubbing and Riot auth token redaction.

**Filters are URI prefixes applied at ingest.** The unfiltered firehose fills the buffer quickly, so pass something like `["/lol-champ-select/", "/lol-gameflow/"]` unless you genuinely want everything.

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

| Key | Default | Meaning |
|---|---|---|
| `allowEval` | `true` | Whether `lol_eval` may run JavaScript in the page |
| `cdpPort` | `8888` | Pengu Loader's remote debugging port |
| `eventBufferSize` | `1000` | Ring buffer capacity; oldest entries are evicted first |
| `writeAllowlist` | `[]` | Which mutating requests `lol_request` may send |
| `wampRecordBufferSize` | `20000` | Recorder timeline entry count |
| `wampRecordMaxBytes` | `67108864` | Recorder byte budget; evicts on whichever fills first |
| `wampRecordPayloadCap` | `512` | Per-payload truncation for the recorder |
| `wampRecordFullPayloadUris` | `["/lol-gameflow/v1/gameflow-phase"]` | URI prefixes exempt from the payload cap |
| `wampRecordFile` | `null` | Optional NDJSON path the timeline is appended to |
| `cdpConsoleBufferSize` | `5000` | Console tailer entry count |
| `cdpNetworkBufferSize` | `5000` | Network tailer entry count; about 50 minutes at the client's measured request rate |
| `logWatchBufferSize` | `5000` | Disk log watcher ring buffer capacity |
| `logsDir` | `null` | Optional custom logs directory override (defaults to auto-detected `Logs/`) |

Allowlist matching rules:

- An entry is `METHOD path`. The method is compared case-insensitively, the path **case-sensitively**.
- `GET` and `HEAD` are always allowed and need no entry.
- `*` is only meaningful as a trailing path segment: `/a/b/*` matches `/a/b/c` but not `/a/b/c/d` and not `/a/b`. Anywhere else it is a literal character.
- A refused call returns the exact config line that would permit it, and the request is never sent.

## Enabling DOM access

`lol_dom_query` and `lol_eval` need the client's CEF remote debugging port, which Riot's build only opens through Pengu Loader — an externally added `--remote-debugging-port` flag is ignored.

Pengu's config is plain `key=value` text, one pair per line — not JSON, not INI. In `C:\Program Files\Pengu Loader\config`, set:

```
RemoteDebuggingPort=8888
```

Then restart the client UX so CEF picks the port up:

```
POST /riotclient/kill-and-restart-ux
```

This leaves a live game untouched. Until it happens, both tools fail with these exact instructions rather than a bare `ECONNREFUSED`.

## Security

- **TLS verification stays on.** The LCU's self-signed certificate is validated against Riot's root CA, vendored at `certs/riotgames.pem`. The server never sets `rejectUnauthorized: false`.
- **The password never leaves the process.** It is held only to build the `Authorization` header — no tool returns it, nothing logs it, and error text is scrubbed of it before it reaches the host. CDP target URLs embed it too, so they are redacted before any tool returns them.
- **`lol_eval` bypasses the write allowlist by construction.** The client page can `fetch` any LCU endpoint from its own origin, so evaluated JavaScript can do anything the client can. This is accepted, not fixed: it is gated by the `allowEval` flag, whose state `lol_status` reports.

> **Treat the write allowlist as a guardrail against mistakes, not as a security boundary — while `allowEval` is `true` it can be bypassed.** Set `allowEval` to `false` for a real boundary. `lol_dom_query` keeps working, because it injects the selector as data rather than as code.

## Development

```bash
npm test        # unit tests via node:test — no League client needed
npm run smoke   # live end-to-end check against a running client
npm start       # run the server on stdio
```

`npm run smoke` prints one line per stage and exits 1 if any stage fails. It is never run in CI. The event stage waits for real delivery and reports three outcomes: `PASS` when events arrived, `SKIP` when the tap connected but an idle client sent nothing, and `FAIL` when the tap could not connect.

```
bin/lcu-mcp.js      # npx entry point
certs/              # Riot's root CA, pinned for TLS verification
config/             # default allowlist.json
scripts/            # lint.mjs (syntax gate) and smoke.mjs (live check)
src/
  index.js          # stdio transport, context wiring, tool registration
  config.js         # config loading and validation
  allowlist.js      # pure write-allowlist matching
  redact.js         # strip passwords from URLs and strings
  backoff.js        # shared reconnect schedule
  clock.js          # injectable time source, so tests never sleep
  lcu/
    lockfile.js     # parse, read, and watch the lockfile
    client.js       # REST with the pinned CA
    buffer.js       # ring buffer with cursor and drop accounting
    ingest.js       # pure ingest policy: prefix filters, truncation
    events.js       # WebSocket tap with backoff reconnect
    recorder.js     # independent WAMP socket for forensic recording
    ndjson.js       # append recorded frames to disk
    timeline.js     # query, filter, and page a recorded timeline
    schema.js       # fetch and dereference the OpenAPI document
    static.js       # lazy per-kind cache over the local game data documents
  cdp/
    discover.js     # probe the debugging port, pick and redact the target
    client.js       # attach, evaluate, DOM query
    console.js      # buffered console tailer on its own socket
    network.js      # buffered HTTP request tailer on its own socket
  logs/
    parser.js       # parse log lines and redact credentials/tokens
    sessions.js     # locate League log folders and active/past sessions
    reader.js       # backward chunk reader from EOF
    watcher.js      # live tailing and timeline buffering
  forensics/
    correlate.js    # merge WAMP and console timelines on one time axis
  tools/            # one module per tool group
tests/              # one test file per source module
```

## Contributing

Pull requests are welcome. The house rules are short: write the test first, keep the runtime dependency list at three, and never let a password reach a buffer, a log, or a tool return. `npm run lint && npm test` must be clean before you open the PR — see [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow.

Found a security issue? Please do not open a public issue — use [private vulnerability reporting](https://github.com/Triggered0/lcu-mcp/security/advisories/new) instead, as described in [SECURITY.md](SECURITY.md).

## Troubleshooting

| Symptom | Cause |
|---|---|
| `League client is not running: no lockfile at ...` | The client is closed, or installed somewhere other than the default path. |
| Every CDP tool fails with a Pengu hint | Pengu Loader is not active, or `RemoteDebuggingPort` is unset. Follow [Enabling DOM access](#enabling-dom-access). |
| `no "page" target` | CDP is reachable but the UX is still starting. Retry once the client is visible. |
| `lol_events_poll` returns nothing | Usually an idle client, not a fault. Navigate the UI and poll again; check `running` in the response. |
| A write is refused | The verb and path are not on the allowlist. The error message contains the exact line to add. |
| TLS errors on every REST call | The vendored CA is wrong or stale. Fix the PEM — never disable verification. |

## Privacy

lcu-mcp runs locally, talks only to `127.0.0.1`, and collects nothing. What it reads from the client flows to the MCP host you connected — see [PRIVACY.md](PRIVACY.md).

## Disclaimer

lcu-mcp is not endorsed by Riot Games and does not reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games and all associated properties are trademarks or registered trademarks of Riot Games, Inc.

This project uses the client's own local API. You are responsible for how you use it; automating gameplay may violate Riot's Terms of Service.

## License

[MIT](LICENSE) © Triggered
