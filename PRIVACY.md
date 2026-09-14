# Privacy Policy

_Last updated: 2026-09-14_

lcu-mcp is a local MCP server. It runs on your machine, under your account, and is started
by your MCP host. There is no lcu-mcp service, no account, and no server operated by the
author. **Nothing is collected, transmitted, or stored by us.**

## What the server talks to

The only network destination is `127.0.0.1`, your own machine:

- the League Client's LCU REST API, on the port and password read from its `lockfile`;
- the client's WAMP event socket, for `lol_events_*` and `lol_wamp_record_*`;
- the Chrome DevTools Protocol port exposed by Pengu Loader, for the CDP tools.

There is no telemetry, no analytics, no crash reporting, and no update check. The server
never opens a listening socket — it speaks to the host over stdio.

## What the server can read

Whatever the connected agent asks for, which may include personal data held by the client:
your summoner name and account identifiers, friends list, lobby and match history, chat
state, the client's console output, its DOM, and screenshots of its window.

**This data flows to the MCP host you connected** — your AI client and, through it, the
model provider it uses. That is the one disclosure worth understanding: lcu-mcp's privacy
surface is your host's privacy surface. Review your host's policy.

## Credentials

The LCU password is read from the client's `lockfile` and held in memory only to build the
`Authorization` header. No tool returns it, nothing logs it, and it is scrubbed from error
text and from CDP target URLs before anything reaches the host. It is never written to disk
by this server.

## Retention

Everything is held in bounded in-memory ring buffers and is gone when the process exits:
event buffer (default 1000 entries), WAMP recording (20000), console tail (5000).

The server writes to disk only when you explicitly ask it to:

- `wampRecordFile` in your config file — appends recorded WAMP traffic as NDJSON;
- the `savePath` argument of `lol_cdp_screenshot` — writes a screenshot to that path.

Both are off by default. Files written this way are yours; delete them when you like.

## Files and variables read

- the config file at `LCU_MCP_CONFIG`, or the default path reported by `lol_status`;
- the League Client `lockfile`;
- `PENGU_CONFIG_PATH` and `LCU_CDP_PORT`, when set, to locate the debugging port;
- `certs/riotgames.pem`, vendored, to verify the client's certificate.

## Third parties

None. No data is shared, sold, or sent anywhere. Installing from npm or cloning from GitHub
is subject to those providers' own policies, not this one.

## Changes and contact

Material changes will be recorded in this file with a new date. Questions:
[github.com/Triggered0/lcu-mcp/issues](https://github.com/Triggered0/lcu-mcp/issues).
