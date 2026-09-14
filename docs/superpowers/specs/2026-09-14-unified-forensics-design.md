# Sub-project S4: Unified Multi-Stream Forensics (`lol_forensics_*`) Design Specification

## Overview

Troubleshooting League of Legends client issues, telemetry failures, or automation errors requires synchronizing data across fundamentally disparate sources:
1. **LCU WAMP Event Bus**: Push notifications from internal C++ services (`/lol-gameflow/`, `/lol-champ-select/`).
2. **LCU Chromium Embedded Framework (CEF) Console**: Frontend JavaScript errors, warnings, uncaught exceptions.
3. **LCU CEF Network Layer**: HTTP requests issued by client web components against the LCU or external endpoints.
4. **Local Disk Logs**: Low-level C++ logs written to disk by `LeagueClient.exe`, `LeagueClientUx.exe`, and `League of Legends.exe`.
5. **Live Game Client Data**: In-match combat, objective, and player events (when a match is active).

Prior to Sub-project S4, `lol_forensics_correlate` only combined WAMP events and CDP console entries. Sub-project S4 expands the correlation engine into a true **Unified Multi-Stream Forensics Engine** and introduces `lol_forensics_bundle`: a one-stop diagnostic snapshot tool for automated and human triage.

---

## Architectural Principles

1. **Pure Correlation Engine**:
   `src/forensics/correlate.js` contains pure normalization, sorting, filtering, and projection functions with no side effects or I/O.
2. **Unified Wall-Clock Alignment**:
   Events across all streams are normalized to ISO-8601 wall timestamps (`HH:mm:ss.sss`) using monotonic clock offsets or system wall timestamps.
3. **Credential & Token Ingest Redaction**:
   All sensitive data (passwords, auth tokens, session cookies, Bearer tokens) are scrubbed before reaching any forensics output.
4. **Token-Efficient Multi-Format Presentation**:
   Forensics results can be projected into:
   - `narrative`: Single-line chronological log stream (`[HH:mm:ss.sss] [SOURCE:KIND] summary`).
   - `events`: Array of normalized event objects.
   - `summary`: Compact statistics matrix (event counts per stream, error totals, timespan).
   - `markdown`: (For bundle) Comprehensive incident report with system status, active watchers, and incident narrative.
5. **House Rules Compliance**:
   - Node >= 24.0.0, strict ES modules (`"type": "module"`), explicit `.js` extensions.
   - Zero new runtime dependencies.
   - Every tool explicitly declares all 4 MCP annotation hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`).
   - Offline tests only (deterministic mock buffers and clocks).

---

## Component Architecture

```
src/
  forensics/
    correlate.js       # Pure normalization & multi-stream timeline correlation
    bundle.js          # Diagnostic bundle generator (status, timeline, disk fallback, markdown formatting)
  tools/
    forensics.js       # Tool definitions: lol_forensics_correlate, lol_forensics_bundle
```

### 1. `src/forensics/correlate.js`

#### Normalizers
- `normalizeWampEntry(entry)`: Source `'wamp'`, kind `'event' | 'error' | ...`, summary formatted with URI and payload preview.
- `normalizeCdpEntry(entry)`: Source `'cdp'`, kind `'console' | 'exception' | 'reattach'`, level `'error' | 'warning' | ...`.
- `normalizeNetworkEntry(entry)`: Source `'network'`, kind `'request' | 'reattach'`, method, url, status, duration, failure state.
- `normalizeLogEntry(entry)`: Source `'logs'`, kind `'log'`, target (`client | ux | game`), level, scrubbed message.
- `normalizeGameEntry(entry)`: Source `'game'`, kind event name, game time, killer/victim or result details.

#### Correlation Function
```javascript
export function correlateTimelines({
  wampEntries = [],
  cdpEntries = [],
  networkEntries = [],
  logEntries = [],
  gameEntries = [],
  limit = 100,
  sources = null, // Set or Array of allowed sources: ['wamp', 'cdp', 'network', 'logs', 'game']
  levels = null,
  format = 'narrative' // 'narrative' | 'events' | 'summary'
} = {})
```

### 2. `src/forensics/bundle.js`

Generates an end-to-end diagnostics bundle by aggregating:
- System status snapshot (`lcu.isConnected()`, lockfile info, CDP attachment, active tailers).
- Live game state (checks `gameClient.isGameRunning()`).
- Active timeline buffers (WAMP recorder, console tailer, network tailer, log watcher).
- Disk log fallback: if `logWatcher` is not actively running, reads the last N lines of the active client log using `logReader` so diagnostics are never empty.
- Formatters:
  - `markdown`: Complete triage document with status breakdown, error alerts, and chronological narrative.
  - `json`: Structured raw payload suitable for machine parsing.

### 3. `src/tools/forensics.js`

Registers MCP tools:
1. `lol_forensics_correlate`:
   - Updated with parameters: `since`, `until`, `limit`, `sources`, `uriPrefix`, `levels`, `networkFailedOnly`, `format`.
   - Annotations: `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`.
2. `lol_forensics_bundle`:
   - Parameters:
     - `since`: optional epoch ms or clock ts
     - `until`: optional epoch ms or clock ts
     - `limit`: max events in timeline (default 200)
     - `sources`: optional array of sources to include
     - `includeLogTail`: boolean (default true)
     - `format`: `'markdown' | 'json'` (default `'markdown'`)
   - Annotations: `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`.

---

## Error Handling & Edge Cases

1. **Unstarted Watchers**:
   If a particular watcher (e.g. `networkTailer` or `logWatcher`) is not started, `correlate` and `bundle` do not throw. They gracefully omit that stream and report the status.
2. **Disk Log Fallback**:
   When `lol_forensics_bundle` runs and `logWatcher` is inactive, it calls `logFinder.findSessions('client', 1)` and `logReader.tail({ target: 'client', lines: 50 })` to ensure recent log events are available for inspection.
3. **Empty Streams**:
   When no events match the given window or filters, returns a clean empty header or zeroed summary instead of failing.
4. **Clock Skew / Reattaches**:
   Entries with wall clock timestamps are preferred for inter-process alignment; monotonic timestamps are used as secondary ordering.
