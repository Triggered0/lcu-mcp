# LCU Forensics — CDP Console Tail + WAMP Event Recorder

## Goal

Isolate a "WebSocket dies mid-session and never reconnects" failure in a
League client renderer plugin. When gameflow events stop arriving at the
page, exactly one of three things happened:

1. The LCU never emitted the event.
2. The LCU emitted it, but it never reached the page.
3. The page received it and mishandled it.

Nothing in the server today can tell these apart. This design adds two
independent observation points that, read together, can:

- a **WAMP recorder** running in the Node process, proving what the LCU put
  on the wire and when, and
- a **CDP console tailer**, capturing what the page logged while nobody was
  watching.

Both must survive unattended across a 40-minute game and a client restart.

## Non-goals

Deferred until the above works; a hardcoded port 8888 and first-`page`
target selection are sufficient in the interim:

- `lol_cdp_targets` — listing attachable targets for manual selection.
- Reading `RemoteDebuggingPort` from the Pengu Loader config file.

## Locked decisions

| Decision | Rationale |
|---|---|
| Recorder gets its own WAMP socket, not `LcuEventTap`'s | Its only value is that nothing can perturb it. Sharing state with the live watch defeats the purpose. The LCU accepts multiple WAMP connections. |
| Firehose (`[5, "OnJsonApiEvent"]`) is the default | A per-URI subscription cannot distinguish "socket dead" from "nothing happened" — both look like an empty buffer. Other URIs still flowing is the proof the socket is alive. |
| Per-URI subscribe is an option, not the default | Useful for reproducing what the page-side plugin subscribes to. Not ground truth. |
| No ingest filtering, ever | Filtering on the way in destroys the negative evidence the firehose exists to provide. Filtering belongs at dump. |
| One timeline, `kind`-discriminated | "The socket died" is only an answer if the close code sits next to the last event that got through. |
| Console tailer gets its own `CdpClient` | An aggressive reconnect supervisor must not destabilise `lol_eval` / `lol_dom_query`. |
| Console buffer is one timeline tagged with `targetId` | Re-attach across a renderer reload is the point. A map keyed by target means five reloads need five ids to reconstruct one session; per-target becomes a dump filter instead. |
| Explicit console `start`/`tail`/`stop`, no auto-start | The first call that reads the buffer happens *after* the game, so auto-start would begin buffering exactly when it is too late and return an empty buffer that reads as "the page logged nothing". |
| `decodeFrame` is not generalised; parsing is extracted | `tests/ingest.test.js:12` asserts the exact behaviour a generalisation loosens. Keeping the contract byte-identical means the tap's safety is proven by untouched tests. |
| No new `cdp_eval` tool | `lol_eval` already does `Runtime.evaluate` with `returnByValue` + `awaitPromise`. A `targetId` parameter is the only real difference; a second tool would be duplication. |

## The shared clock

The recorder runs in the Node process; the page-side probe runs in the
renderer. Correlating them only works on a shared clock, and
`performance.now()` is per-process.

Anchor once at recorder start:

```js
const epochAnchor = Date.now();
const hrAnchor = process.hrtime.bigint();
const now = () => epochAnchor + Number(process.hrtime.bigint() - hrAnchor) / 1e6;
```

This yields sub-millisecond resolution on a wall-clock-comparable scale, and
is immune to an NTP step mid-session (which plain `Date.now()` is not).

`ts` is epoch milliseconds as a float. It is the field `dump` sorts and
range-filters on. A monotonic `seq` sits alongside it for ordering *within*
the process, but it is not the clock.

### Both stamps on both sides

Every entry, recorder and console alike, carries two receive-side stamps:

- `ts` — the anchored clock above: sub-millisecond, NTP-step-immune.
- `wallTs` — a raw `Date.now()` taken at the same instant.

Console entries additionally carry `pageTs`, CDP's
`Runtime.consoleAPICalled.timestamp`, which is already epoch milliseconds and
so needs no conversion. The `ts`/`pageTs` delta is itself a delivery-latency
signal.

The anchored clock's immunity to an NTP step is exactly why the raw stamp has
to travel with it. CDP's timestamp is *raw* epoch, so under the very step the
anchoring protects against, the two clocks disagree — and the whole design is
about correlating across them. Carrying both fields on both sides makes that
disagreement visible in the data instead of load-bearing and invisible.

## Component A — WAMP recorder

`src/lcu/recorder.js`, class `WampRecorder`.

### Timeline entries

One buffer, entries discriminated by `kind`. Socket and recorder lifecycle
are entries, not side state — under a dead socket there may be no first
frame, so "the recording began here" must be visible in the data rather than
inferred from the first frame's timestamp.

`mode` is `'firehose'` or `'uris'`. `reason` on `stop` is `'tool'` (an explicit
`lol_wamp_record_stop`) or `'shutdown'` (the MCP process exiting).

All entries carry `ts`, `wallTs` and `seq`; the fields below are in addition.

```
{ kind:'start',   uris, mode, bufferSize, maxBytes, payloadCap }
{ kind:'stop',    reason }
{ kind:'restart', previousStartedAt, previousEntries }
{ kind:'open',    port, attempt }
{ kind:'close',   code, reason, wasClean }
{ kind:'error',   message }
{ kind:'gap',     durationMs, sinceTs }
{ kind:'event',   uri, eventType, endpoint, data, truncated }
```

### Subscription

`uris` omitted or empty means firehose, `[5, "OnJsonApiEvent"]`. Otherwise one
subscribe frame per URI, with `/` replaced by `_`:
`/lol-gameflow/v1/gameflow-phase` becomes
`[5, "OnJsonApiEvent_lol-gameflow_v1_gameflow-phase"]`.

`decodeFrame` in `src/lcu/ingest.js` hardcodes `frame[1] !== 'OnJsonApiEvent'`.
It must **not** be generalised. `tests/ingest.test.js:12` deliberately asserts
the behaviour a generalisation would loosen:

```js
assert.equal(decodeFrame(JSON.stringify([8, 'OnJsonApiEvent_x', { uri: '/x' }])), null);
```

Generalising therefore does not risk a *silent* regression — it turns that test
red immediately. The hazard is that the obvious way to make it green again is
to weaken or delete the one assertion protecting `LcuEventTap`.

Extract the shared parsing instead:

```
parseWampFrame(raw) -> { endpoint, payload } | null
    text/Buffer -> JSON -> Array -> frame[0] === 8 -> payload is an object

decodeFrame(raw)       // unchanged contract, firehose only:
                       // endpoint must equal 'OnJsonApiEvent'
decodeEventFrame(raw)  // recorder: accepts OnJsonApiEvent*, returns endpoint
```

`decodeFrame`'s observable behaviour stays byte-identical and
`tests/ingest.test.js` is not touched at all, so "the tap did not regress" is
proven by untouched tests rather than edited ones. On the one function both
subsystems sit on, that is worth a six-line helper. The two consumers want
different return shapes anyway — the recorder needs the endpoint, the tap does
not.

### Per-URI statistics

Kept outside the ring buffer, so they survive eviction. This is the primary
signal, not a convenience: under a firehose the real threat to the evidence
is eviction, and an evicted event is indistinguishable from an absent one in
the replay alone.

```
stats: { [uri]: { count, firstTs, lastTs } }
```

`count` is cumulative since recording start and is never decremented. `lastTs`
answers "quiet since when" — the actual diagnostic question. Together they
make "socket alive but this URI quiet" visible at a glance without a replay.

### Bounding

Entry size varies by two orders of magnitude across URIs
(`/lol-champ-select/v1/session` pushes multi-KB payloads several times a
second for the whole of champ select), so a count-only ring is unpredictable
under a firehose. Evict on whichever budget fills first:

- `wampRecordBufferSize` — 20000 entries.
- `wampRecordMaxBytes` — 64 MB, measured as the UTF-8 byte length of each
  stored entry, maintained as a running total.

Payloads are capped at `wampRecordPayloadCap` (512 bytes) — far below
`lol_events_*`'s 4 KB, because ground truth needs "a frame arrived on this
URI at time T" and the payload is irrelevant for all but the handful of URIs
under active correlation. URIs matching a `wampRecordFullPayloadUris` prefix
keep their full payload. `truncateData` already takes a `max` parameter and
needs no change.

At a 512-byte cap, 20000 entries is roughly 10 MB, so the count is the only
knob that normally matters.

### Durability

`wampRecordFile` (optional, default off): append each entry as NDJSON via
`fs.createWriteStream({ flags: 'a' })` as it arrives. Both a wrapped ring
buffer and a restarted MCP process lose the evidence *silently*, which is the
one outcome that wastes an entire game session. The ring buffer stays the
default; the file is a flag.

A write error (full disk, bad path) records an `error` entry into the
timeline and disables further writes. It must never terminate the recording.

### Reconnect

Reuses `LcuEventTap`'s owner-token backoff loop in structure: the token
correctly orphans an in-flight loop on stop and prevents one failed attempt
from scheduling two loops. `client.invalidate()` runs before each retry so a
restarted LCU's new port is picked up. Reconnect emits a `gap` entry with
`durationMs` measured from the preceding `close`.

### Tools

- `lol_wamp_record_start({ uris?, restart? })`
- `lol_wamp_record_dump({ uri?, since?, until?, kinds?, limit?, cursor? })`
- `lol_wamp_record_stop()`

`start` while already running is an **error**, not a silent continuation: a
recording whose start time cannot be trusted is worse than no recording,
because conclusions get drawn from it. The error reports when the current
recording started and how many entries it holds, so the caller can judge
whether discarding is safe. `restart: true` overrides, and must drop the old
buffer and open a fresh socket rather than reusing either — a restart that
keeps old frames has the same misdating problem in a quieter form. The
`restart` entry is then the first entry of the *new* buffer, carrying
`previousStartedAt` and `previousEntries` so that what was discarded is itself
on the record.

`dump` returns `{ entries, stats, dropped, cursor, running, startedAt }`.
`uri` is a prefix filter over `kind:'event'` entries; lifecycle entries are
always included unless `kinds` excludes them explicitly, since they are
usually the answer. `dropped` is always reported so silence-by-eviction is
never read as silence-by-absence.

## Component B — CDP console tailer

`src/cdp/console.js`, class `ConsoleTailer`, with its own `CdpClient`.

### Prerequisite change to `CdpClient`

`#handleMessage` currently drops every unsolicited event
(`src/cdp/client.js:75`, `if (message.id === undefined) return;`). It needs an
`on(method, handler)` dispatch so `Runtime.consoleAPICalled` and
`Runtime.exceptionThrown` can be subscribed. Existing request/response
behaviour is unchanged.

### Buffering

`Runtime.enable` on attach, then buffer. As with the recorder, every entry
carries `ts`, `wallTs` and `seq`:

```
{ kind:'console',   pageTs, targetId, level, args, stackTop, url }
{ kind:'exception', pageTs, targetId, text, description, stackTop, url }
{ kind:'reattach',  previousTargetId, targetId, gapMs }
```

`consoleAPICalled` delivers `RemoteObject` arguments. Deep-serialising them is
expensive on a hot log path, so use `value` when present, falling back to
`description`, then `preview`, capped per argument and per entry.

Buffer size `cdpConsoleBufferSize`, default 5000.

### Re-attach supervisor

The entire point is capturing what happened across a renderer reload, when
the target id changes. On socket close or `Inspector.targetCrashed`, poll
`/json/list` on a backoff, re-discover the page target, re-attach, re-issue
`Runtime.enable`, and push a `reattach` entry recording the old and new target
ids and the gap. Buffering continues in the background between tool calls.

### Tools

- `lol_cdp_console_start()`
- `lol_cdp_console_tail({ since?, until?, cursor?, limit?, level?, targetId?, text? })`
- `lol_cdp_console_stop()`

An explicit triple, matching the other nine tools. **Tailing a stopped tailer
is an error, not an empty success.**

Auto-starting on first call was considered and rejected. It does not do what it
appears to: the tailer exists to capture an unattended 40-minute game, but the
first call that *reads* the buffer happens after the game. If that read is also
the first call, auto-start begins buffering at the moment one sits down to
review what was missed, and returns an empty buffer. Capturing the game still
requires a call beforehand — auto-start removes the word "start" from the
workflow, not the requirement.

It also makes forgetting silent. `{ entries: [], running: true }` reads as "the
page logged nothing" when the truth is "nothing was listening." That is the
same silence-by-absence versus silence-by-something-else confusion the recorder
avoids by always reporting `dropped`, and the console tailer must not
reintroduce it. A loud error at the moment it matters beats a plausible-looking
empty result — the same reasoning that makes a second `start` an error.

The second CDP socket then exists only for the duration of an explicit session,
which disposes of the resource objection too.

`level` filters console entries by severity (`log`, `warning`, `error`, …);
`text` is a case-insensitive substring match over the rendered arguments and
exception text; `targetId` narrows to one renderer incarnation. As with the
recorder, `reattach` entries survive every filter — a reload is context for
whatever is being read, not noise to be filtered out.

## Component C — structured `exceptionDetails`

`CdpClient.evaluate()` currently throws on a page exception and keeps only a
description string, discarding the stack. For debugging this is backwards;
the exception is data.

`evaluate()` returns `{ value, exceptionDetails }`. `exceptionDetails` carries
`text`, `lineNumber`, `columnNumber`, `exception.description` and trimmed
`stackTrace.callFrames`.

Two callers change:

- `domQuery` throws when `exceptionDetails` is present, preserving its
  contract.
- `lol_eval` returns both fields.

`tests/cdp-client.test.js` and `tests/tools-dom.test.js` need updating for the
new return shape.

## Security — a new redaction path

`guard()` redacts secrets from *thrown errors* only
(`src/tools/result.js:16`). Exception text and console arguments are **success**
payloads, so they bypass it entirely.

This is a live leak path, not a theoretical one: the plugin under debug builds
`wss://riot:<password>@127.0.0.1:<port>/` URLs, so a thrown exception or a
stray `console.log` of that URL would put the LCU password directly into a
tool result.

`redactSecrets` therefore runs over console entries, `exceptionDetails`, and
recorder `error` entries **at ingest**, before anything enters a buffer or the
NDJSON file. The recorder additionally keeps the `#knownPasswords` set that
`LcuEventTap` maintains, so a stale password from a prior port is scrubbed too.

## Configuration

Added to `config/allowlist.json` and `DEFAULTS` in `src/config.js`, each with
validation matching the existing style:

| Key | Default | Meaning |
|---|---|---|
| `wampRecordBufferSize` | `20000` | Recorder ring buffer entry count |
| `wampRecordMaxBytes` | `67108864` | Recorder byte budget; evicts on whichever fills first |
| `wampRecordPayloadCap` | `512` | Per-payload truncation for the recorder |
| `wampRecordFullPayloadUris` | `["/lol-gameflow/v1/gameflow-phase"]` | URI prefixes exempt from the payload cap |
| `wampRecordFile` | `null` | Optional NDJSON append path |
| `cdpConsoleBufferSize` | `5000` | Console tailer ring buffer entry count |

## Testing

Following the existing pattern of injected `wsFactory` and `delay`, with no
live client required:

- Dual-budget eviction: count fills first; bytes fill first; per-URI `count`
  survives eviction while entries do not.
- Lifecycle ordering: `close` with its code sits immediately after the last
  event that got through; `gap` duration measured from `close` to reconnect.
- `start` while running errors and reports `startedAt` plus entry count;
  `restart: true` drops the buffer and opens a fresh socket.
- Firehose vs per-URI subscribe frame construction. `tests/ingest.test.js` must
  remain **untouched and green** — that is the regression check for
  `LcuEventTap`, and editing it would defeat the purpose of the extraction.
  New tests cover `parseWampFrame` and `decodeEventFrame` only.
- Console re-attach across a target-id change emits `reattach` and keeps
  buffering.
- `lol_cdp_console_tail` against a stopped tailer errors rather than returning
  an empty success.
- Redaction: a password in a console argument, an `exceptionDetails` text and
  a recorder `error` never reaches the buffer or the NDJSON file.
- Clock: under a simulated wall-clock step, `ts` stays monotonic while `wallTs`
  jumps, and both are present on recorder and console entries alike.
- `tests/tools-status.test.js` asserts the exact registered tool set ("the
  server registers exactly the tools wired so far") and must be extended as
  each tool lands.

## Phasing

1. `lol_wamp_record_*` — `parseWampFrame` extraction, recorder, dual-budget
   buffer, lifecycle timeline, per-URI stats, reconnect.
2. `lol_cdp_console_start/tail/stop` — `CdpClient` event dispatch, tailer,
   re-attach supervisor.
3. `wampRecordFile` NDJSON durability.
4. `exceptionDetails` on `lol_eval`.
5. Deferred: `lol_cdp_targets`, Pengu config port read.

Durability comes before `exceptionDetails`: it is the difference between losing
a game session and not, whereas structured exception details can be worked
around with a `try/catch` inside the evaluated expression.
