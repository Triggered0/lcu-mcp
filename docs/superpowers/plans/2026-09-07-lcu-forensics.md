# LCU Forensics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a WAMP event recorder and a CDP console tailer to the LCU MCP server, so that a "WebSocket dies mid-session and never reconnects" failure can be diagnosed by comparing what the LCU emitted against what the page received.

**Architecture:** Two observation points, each with its own socket so neither can perturb the other. The recorder opens a second WAMP WebSocket to the LCU from the Node process and records a single `kind`-discriminated timeline (events *and* socket lifecycle) into a dual-budget ring buffer. The console tailer opens its own CDP socket, subscribes to `Runtime.consoleAPICalled` / `Runtime.exceptionThrown`, and re-attaches across renderer reloads. Both stamp entries with an anchored clock plus a raw `Date.now()`, so the two processes can be correlated and any clock disagreement stays visible.

**Tech Stack:** Node >= 24, ESM, `node:test`, `ws`, `zod`, `@modelcontextprotocol/sdk`.

**Spec:** `docs/superpowers/specs/2026-09-07-lcu-forensics-design.md`

## Global Constraints

- **Node >= 24**, ESM only (`"type": "module"`). No transpilation.
- **No new dependencies.** Only `ws`, `zod`, `@modelcontextprotocol/sdk` and the Node standard library.
- **English only** in all code, comments, identifiers, docs and commit messages.
- **The LCU password must never** appear in a buffer entry, a tool result, an error message, a status snapshot or the NDJSON file. Redaction happens **at ingest**, before anything is stored.
- **`tests/ingest.test.js` must not be edited.** It is the regression check for `LcuEventTap`. If a change turns it red, the change is wrong — do not edit the test.
- **`decodeFrame`'s observable behaviour must stay byte-identical.**
- Tests run with `npm test` (`node --test`). Baseline before this plan: **120 passing**. Every task must leave the suite green.
- Follow existing file idioms: `#private` fields, injected `wsFactory` / `delay` / `discover` for testability, `guard(...)` + `ok(...)` / `fail(...)` for tools.
- Commit after every task.

---

## File Structure

**New:**

| File | Responsibility |
|---|---|
| `src/clock.js` | Anchored epoch clock shared by both subsystems |
| `src/lcu/timeline.js` | `TimelineBuffer` — dual-budget (count + bytes) ring with cursor/time/kind selection |
| `src/lcu/recorder.js` | `WampRecorder` — second WAMP socket, lifecycle timeline, per-URI stats |
| `src/lcu/ndjson.js` | `NdjsonSink` — append-as-you-go durability |
| `src/cdp/console.js` | `ConsoleTailer` — console/exception buffering, re-attach supervisor |
| `src/tools/recorder.js` | `lol_wamp_record_start` / `_dump` / `_stop` |
| `src/tools/console.js` | `lol_cdp_console_start` / `_tail` / `_stop` |

**Modified:**

| File | Change |
|---|---|
| `src/lcu/ingest.js` | Extract `parseWampFrame`; add `decodeEventFrame`, `subscribeEndpoint`. `decodeFrame` contract unchanged. |
| `src/cdp/client.js` | Add `on(method, handler)` event dispatch and `onClose(handler)`; later, `evaluate()` return shape |
| `src/config.js` | Six new config keys with validation |
| `config/allowlist.json` | Same six keys with defaults |
| `src/index.js` | Wire recorder + tailer into the context and server |
| `src/tools/status.js` | Report recorder and tailer state |
| `src/tools/dom.js` | `lol_eval` returns `exceptionDetails` (Task 13) |
| `tests/tools-status.test.js` | Extend the exact-tool-set assertion as tools land |
| `tests/cdp-client.test.js`, `tests/tools-dom.test.js` | Updated for the new `evaluate()` shape (Task 13) |

**Untouched by design:** `tests/ingest.test.js`, `src/lcu/events.js`, `src/lcu/buffer.js`.

---

## Phase 1 — WAMP recorder (Tasks 1-7)

### Task 1: Anchored clock

**Files:**
- Create: `src/clock.js`
- Test: `tests/clock.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `createClock({ epochNow?, hrNow? }) -> { now(): number, wall(): number }`. `now()` returns anchored epoch milliseconds as a float; `wall()` returns raw `Date.now()`.

- [x] **Step 1: Write the failing test**

```js
// tests/clock.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClock } from '../src/clock.js';

test('now is anchored to the epoch at construction', () => {
  let hr = 0n;
  const clock = createClock({ epochNow: () => 1_700_000_000_000, hrNow: () => hr });
  hr = 1_500_000n; // 1.5 ms later in nanoseconds
  assert.equal(clock.now(), 1_700_000_000_001.5);
});

test('now survives a wall-clock step that wall does not', () => {
  let hr = 0n;
  let epoch = 1_700_000_000_000;
  const clock = createClock({ epochNow: () => epoch, hrNow: () => hr });

  hr = 5_000_000n; // 5 ms of real time passes
  epoch = 1_699_999_000_000; // NTP steps the wall clock one second backwards

  assert.equal(clock.now(), 1_700_000_000_005); // unaffected by the step
  assert.equal(clock.wall(), 1_699_999_000_000); // reports the step honestly
});

test('now has sub-millisecond resolution', () => {
  let hr = 0n;
  const clock = createClock({ epochNow: () => 1_000, hrNow: () => hr });
  hr = 250_000n; // 0.25 ms
  assert.equal(clock.now(), 1_000.25);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/clock.test.js`
Expected: FAIL — `Cannot find module '../src/clock.js'`

- [x] **Step 3: Write minimal implementation**

```js
// src/clock.js

// The recorder runs in this process; the page-side probe runs in the renderer.
// Correlating them needs a shared clock, and `performance.now()` is per-process.
// Anchoring a monotonic source to one epoch reading gives sub-millisecond
// resolution on a wall-clock-comparable scale that an NTP step cannot move.
// `wall()` is kept alongside it precisely so that a step stays visible in the
// data: CDP's own timestamps are raw epoch, so under a step the two disagree.
export function createClock({ epochNow = Date.now, hrNow = process.hrtime.bigint } = {}) {
  const epochAnchor = epochNow();
  const hrAnchor = hrNow();
  return {
    now: () => epochAnchor + Number(hrNow() - hrAnchor) / 1e6,
    wall: () => epochNow()
  };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test tests/clock.test.js`
Expected: PASS, 3 tests

- [x] **Step 5: Run the full suite**

Run: `npm test`
Expected: 123 passing, 0 failing

- [x] **Step 6: Commit**

```bash
git add src/clock.js tests/clock.test.js
git commit -m "feat: add an anchored epoch clock for cross-process correlation"
```

---

### Task 2: WAMP frame parsing extraction

**Files:**
- Modify: `src/lcu/ingest.js`
- Test: `tests/wamp-frame.test.js`
- **Must stay untouched and green:** `tests/ingest.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `parseWampFrame(raw) -> { endpoint: string, payload: object } | null`
  - `decodeEventFrame(raw) -> { endpoint, eventType, uri, data } | null` — accepts any `OnJsonApiEvent*` endpoint
  - `subscribeEndpoint(uri) -> string` — `/lol-gameflow/v1/gameflow-phase` becomes `OnJsonApiEvent_lol-gameflow_v1_gameflow-phase`
  - `decodeFrame(raw)` — **unchanged contract**, firehose only

**Why an extraction and not a generalisation:** `tests/ingest.test.js:12` asserts `decodeFrame(JSON.stringify([8, 'OnJsonApiEvent_x', { uri: '/x' }])) === null`. Loosening `decodeFrame` turns that test red, and the tempting fix deletes the one assertion protecting `LcuEventTap`. Keeping the contract byte-identical means the tap's safety is proven by tests nobody edited.

- [x] **Step 1: Write the failing test**

```js
// tests/wamp-frame.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEventFrame, decodeFrame, parseWampFrame, subscribeEndpoint } from '../src/lcu/ingest.js';

test('parseWampFrame returns the endpoint and payload of an event frame', () => {
  const raw = JSON.stringify([8, 'OnJsonApiEvent_lol-gameflow_v1_gameflow-phase', { uri: '/x' }]);
  assert.deepEqual(parseWampFrame(raw), {
    endpoint: 'OnJsonApiEvent_lol-gameflow_v1_gameflow-phase',
    payload: { uri: '/x' }
  });
});

test('parseWampFrame rejects non-frames without throwing', () => {
  assert.equal(parseWampFrame(''), null);            // the subscribe ack
  assert.equal(parseWampFrame('not json'), null);
  assert.equal(parseWampFrame(JSON.stringify({})), null);      // not an array
  assert.equal(parseWampFrame(JSON.stringify([5, 'x'])), null); // wrong opcode
  assert.equal(parseWampFrame(JSON.stringify([8, 'x', null])), null);
  assert.equal(parseWampFrame(JSON.stringify([8, 'x', 'nope'])), null);
});

test('parseWampFrame accepts a Buffer, as ws delivers', () => {
  const raw = Buffer.from(JSON.stringify([8, 'OnJsonApiEvent', { uri: '/x' }]));
  assert.equal(parseWampFrame(raw)?.endpoint, 'OnJsonApiEvent');
});

test('decodeEventFrame accepts a per-URI endpoint and reports it', () => {
  const raw = JSON.stringify([
    8,
    'OnJsonApiEvent_lol-gameflow_v1_gameflow-phase',
    { eventType: 'Update', uri: '/lol-gameflow/v1/gameflow-phase', data: 'ChampSelect' }
  ]);
  assert.deepEqual(decodeEventFrame(raw), {
    endpoint: 'OnJsonApiEvent_lol-gameflow_v1_gameflow-phase',
    eventType: 'Update',
    uri: '/lol-gameflow/v1/gameflow-phase',
    data: 'ChampSelect'
  });
});

test('decodeEventFrame also accepts the firehose endpoint', () => {
  const raw = JSON.stringify([8, 'OnJsonApiEvent', { eventType: 'Create', uri: '/a', data: 1 }]);
  assert.equal(decodeEventFrame(raw)?.endpoint, 'OnJsonApiEvent');
});

test('decodeEventFrame rejects an endpoint that is not an OnJsonApiEvent', () => {
  assert.equal(decodeEventFrame(JSON.stringify([8, 'OnOtherThing', { uri: '/x' }])), null);
});

// The contract tests/ingest.test.js depends on, restated here so that the
// extraction cannot quietly widen decodeFrame without a second alarm.
test('decodeFrame still rejects a per-URI endpoint', () => {
  assert.equal(decodeFrame(JSON.stringify([8, 'OnJsonApiEvent_x', { uri: '/x' }])), null);
  assert.equal(decodeFrame(JSON.stringify([8, 'OnJsonApiEvent', { uri: '/x' }]))?.uri, '/x');
});

test('subscribeEndpoint replaces every slash with an underscore', () => {
  assert.equal(
    subscribeEndpoint('/lol-gameflow/v1/gameflow-phase'),
    'OnJsonApiEvent_lol-gameflow_v1_gameflow-phase'
  );
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/wamp-frame.test.js`
Expected: FAIL — `parseWampFrame is not a function`

- [x] **Step 3: Replace `decodeFrame` in `src/lcu/ingest.js` with the extraction**

Delete the existing `decodeFrame` (the last function in the file, with its comment) and append:

```js
// The subscribe ack arrives as an empty frame; parsing it as JSON throws.
// Shared by decodeFrame (firehose only) and decodeEventFrame (any
// OnJsonApiEvent*). Kept separate so decodeFrame's contract — which
// tests/ingest.test.js pins — cannot drift when the recorder's needs change.
export function parseWampFrame(raw) {
  const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
  if (text.trim().length === 0) return null;
  let frame;
  try {
    frame = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(frame) || frame[0] !== 8) return null;
  const payload = frame[2];
  if (payload === null || typeof payload !== 'object') return null;
  return { endpoint: frame[1], payload };
}

export function decodeFrame(raw) {
  const parsed = parseWampFrame(raw);
  if (parsed === null || parsed.endpoint !== 'OnJsonApiEvent') return null;
  const { payload } = parsed;
  return { eventType: payload.eventType, uri: payload.uri, data: payload.data };
}

// The recorder subscribes either to the firehose or per URI, so it must accept
// both 'OnJsonApiEvent' and 'OnJsonApiEvent_lol-gameflow_v1_gameflow-phase',
// and it needs the endpoint back to record which subscription delivered.
export function decodeEventFrame(raw) {
  const parsed = parseWampFrame(raw);
  if (parsed === null || typeof parsed.endpoint !== 'string') return null;
  if (!parsed.endpoint.startsWith('OnJsonApiEvent')) return null;
  const { payload } = parsed;
  return {
    endpoint: parsed.endpoint,
    eventType: payload.eventType,
    uri: payload.uri,
    data: payload.data
  };
}

export function subscribeEndpoint(uri) {
  return `OnJsonApiEvent${uri.replace(/\//g, '_')}`;
}
```

- [x] **Step 4: Run both frame test files**

Run: `node --test tests/wamp-frame.test.js tests/ingest.test.js`
Expected: PASS. `tests/ingest.test.js` must be green **without having been edited** — confirm with `git diff --stat tests/ingest.test.js` printing nothing.

- [x] **Step 5: Run the full suite**

Run: `npm test`
Expected: 131 passing, 0 failing

- [x] **Step 6: Commit**

```bash
git add src/lcu/ingest.js tests/wamp-frame.test.js
git commit -m "refactor: extract WAMP frame parsing and add a per-URI decoder"
```

---

### Task 3: Dual-budget timeline buffer

**Files:**
- Create: `src/lcu/timeline.js`
- Test: `tests/timeline.test.js`

**Interfaces:**
- Consumes: `createClock` from Task 1
- Produces: `class TimelineBuffer`
  - `new TimelineBuffer({ maxEntries, maxBytes = Infinity, clock })`
  - `push(entry) -> stored` — stamps `seq`, `ts`, `wallTs`
  - `select({ cursor = 0, since = null, until = null, limit = 100, kinds = null, predicate = null }) -> { entries, cursor, dropped, remaining }`
  - `get length`, `get bytes`, `get droppedTotal`
  - `clear()`

**Why bytes as well as count:** entry size varies by two orders of magnitude across URIs — `/lol-champ-select/v1/session` pushes multi-KB payloads several times a second — so a count-only ring has unpredictable memory under a firehose.

- [x] **Step 1: Write the failing test**

```js
// tests/timeline.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TimelineBuffer } from '../src/lcu/timeline.js';

// A deterministic clock: one millisecond per push.
function fakeClock(start = 1000) {
  let t = start;
  return { now: () => (t += 1), wall: () => t + 500_000 };
}

function make({ maxEntries = 10, maxBytes = Infinity } = {}) {
  return new TimelineBuffer({ maxEntries, maxBytes, clock: fakeClock() });
}

test('push stamps seq, ts and wallTs, and the entry cannot overwrite them', () => {
  const buffer = make();
  const stored = buffer.push({ kind: 'event', uri: '/a', seq: 999, ts: 0, wallTs: 0 });
  assert.equal(stored.seq, 1);
  assert.equal(stored.ts, 1001);
  assert.equal(stored.wallTs, 501_001);
});

test('the count budget evicts oldest first', () => {
  const buffer = make({ maxEntries: 3 });
  for (let i = 0; i < 5; i += 1) buffer.push({ kind: 'event', uri: '/a' });
  assert.equal(buffer.length, 3);
  assert.deepEqual(buffer.select({ limit: 100 }).entries.map((e) => e.seq), [3, 4, 5]);
  assert.equal(buffer.droppedTotal, 2);
});

test('the byte budget evicts before the count budget is reached', () => {
  const buffer = make({ maxEntries: 1000, maxBytes: 400 });
  for (let i = 0; i < 20; i += 1) buffer.push({ kind: 'event', uri: '/a', data: 'x'.repeat(50) });
  assert.ok(buffer.length < 20, 'byte budget should have evicted entries');
  assert.ok(buffer.bytes <= 400, `bytes ${buffer.bytes} should be within budget`);
  assert.ok(buffer.droppedTotal > 0);
});

test('a single oversized entry is kept rather than evicted forever', () => {
  const buffer = make({ maxEntries: 10, maxBytes: 10 });
  buffer.push({ kind: 'event', uri: '/a', data: 'x'.repeat(500) });
  assert.equal(buffer.length, 1);
});

test('dropped is reported relative to the caller cursor', () => {
  const buffer = make({ maxEntries: 3 });
  for (let i = 0; i < 10; i += 1) buffer.push({ kind: 'event', uri: '/a' });
  const { entries, dropped } = buffer.select({ cursor: 2, limit: 100 });
  assert.deepEqual(entries.map((e) => e.seq), [8, 9, 10]);
  assert.equal(dropped, 5); // seq 3..7 were evicted after the caller's cursor
});

test('a time range filters on ts', () => {
  const buffer = make();
  for (let i = 0; i < 5; i += 1) buffer.push({ kind: 'event', uri: '/a' });
  // ts values are 1001..1005
  const { entries } = buffer.select({ since: 1002, until: 1004, limit: 100 });
  assert.deepEqual(entries.map((e) => e.ts), [1002, 1003, 1004]);
});

test('kinds is the only filter that can exclude a lifecycle entry', () => {
  const buffer = make();
  buffer.push({ kind: 'open', port: 1 });
  buffer.push({ kind: 'event', uri: '/a' });
  buffer.push({ kind: 'close', code: 1006 });

  const all = buffer.select({ limit: 100 });
  assert.deepEqual(all.entries.map((e) => e.kind), ['open', 'event', 'close']);

  const only = buffer.select({ kinds: ['event'], limit: 100 });
  assert.deepEqual(only.entries.map((e) => e.kind), ['event']);
});

test('a predicate filters without disturbing cursor accounting', () => {
  const buffer = make();
  buffer.push({ kind: 'event', uri: '/keep' });
  buffer.push({ kind: 'event', uri: '/drop' });
  buffer.push({ kind: 'event', uri: '/keep' });
  const { entries, cursor } = buffer.select({
    predicate: (e) => e.uri === '/keep',
    limit: 100
  });
  assert.equal(entries.length, 2);
  assert.equal(cursor, 3); // the cursor tracks the real seq, not the filtered count
});

test('limit paginates and reports what remains', () => {
  const buffer = make();
  for (let i = 0; i < 6; i += 1) buffer.push({ kind: 'event', uri: '/a' });
  const { entries, cursor, remaining } = buffer.select({ limit: 2 });
  assert.deepEqual(entries.map((e) => e.seq), [1, 2]);
  assert.equal(cursor, 2);
  assert.equal(remaining, 4);
});

test('an empty result keeps the caller cursor', () => {
  const buffer = make();
  buffer.push({ kind: 'event', uri: '/a' });
  assert.equal(buffer.select({ cursor: 1, limit: 100 }).cursor, 1);
});

test('clear empties the buffer and the byte total but not the seq counter', () => {
  const buffer = make();
  buffer.push({ kind: 'event', uri: '/a' });
  buffer.clear();
  assert.equal(buffer.length, 0);
  assert.equal(buffer.bytes, 0);
  assert.equal(buffer.push({ kind: 'event', uri: '/a' }).seq, 2);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/timeline.test.js`
Expected: FAIL — `Cannot find module '../src/lcu/timeline.js'`

- [x] **Step 3: Write the implementation**

```js
// src/lcu/timeline.js

// A ring bounded by two budgets at once. Entry size varies by two orders of
// magnitude across LCU URIs, so a count-only ring has unpredictable memory
// under a firehose; a byte-only ring has unpredictable depth. Evicting on
// whichever fills first bounds both.
export class TimelineBuffer {
  // Entries are held as { stored, bytes } so the measured size never leaks
  // into the entry a caller sees.
  #entries = [];
  #nextSeq = 1;
  #bytes = 0;
  #droppedTotal = 0;

  constructor({ maxEntries, maxBytes = Infinity, clock }) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error(`TimelineBuffer maxEntries must be a positive integer, got ${maxEntries}`);
    }
    if (!(maxBytes > 0)) {
      throw new Error(`TimelineBuffer maxBytes must be positive, got ${maxBytes}`);
    }
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.clock = clock;
  }

  get length() {
    return this.#entries.length;
  }

  get bytes() {
    return this.#bytes;
  }

  get droppedTotal() {
    return this.#droppedTotal;
  }

  // seq/ts/wallTs go last: the buffer owns them, and an entry that happens to
  // carry one of those fields must not be able to overwrite the cursor's
  // numbering or restamp itself.
  push(entry) {
    const stored = { ...entry, seq: this.#nextSeq, ts: this.clock.now(), wallTs: this.clock.wall() };
    this.#nextSeq += 1;
    const bytes = Buffer.byteLength(JSON.stringify(stored), 'utf8');
    this.#entries.push({ stored, bytes });
    this.#bytes += bytes;
    this.#evict();
    return stored;
  }

  // The length > 1 guard keeps a single entry larger than the whole byte
  // budget rather than evicting it immediately and recording nothing at all.
  #evict() {
    while (
      this.#entries.length > this.maxEntries ||
      (this.#bytes > this.maxBytes && this.#entries.length > 1)
    ) {
      const removed = this.#entries.shift();
      this.#bytes -= removed.bytes;
      this.#droppedTotal += 1;
    }
  }

  select({ cursor = 0, since = null, until = null, limit = 100, kinds = null, predicate = null } = {}) {
    // A negative cursor would otherwise inflate `dropped` past what was pushed.
    const from = Number.isFinite(cursor) && cursor > 0 ? cursor : 0;
    const oldestSeq = this.#entries.length > 0 ? this.#entries[0].stored.seq : this.#nextSeq;
    const dropped = Math.max(0, oldestSeq - 1 - from);

    let matching = this.#entries.map((e) => e.stored).filter((e) => e.seq > from);
    if (since !== null) matching = matching.filter((e) => e.ts >= since);
    if (until !== null) matching = matching.filter((e) => e.ts <= until);
    if (kinds !== null) matching = matching.filter((e) => kinds.includes(e.kind));
    if (predicate !== null) matching = matching.filter(predicate);

    const entries = matching.slice(0, limit);
    const next = entries.length > 0 ? entries[entries.length - 1].seq : from;
    return { entries, cursor: next, dropped, remaining: matching.length - entries.length };
  }

  clear() {
    this.#entries = [];
    this.#bytes = 0;
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test tests/timeline.test.js`
Expected: PASS, 11 tests

- [x] **Step 5: Run the full suite**

Run: `npm test`
Expected: 142 passing, 0 failing

- [x] **Step 6: Commit**

```bash
git add src/lcu/timeline.js tests/timeline.test.js
git commit -m "feat: add a dual-budget timeline buffer"
```

---

### Task 4: Configuration keys

**Files:**
- Modify: `src/config.js`
- Modify: `config/allowlist.json`
- Test: `tests/config.test.js` (append)

**Interfaces:**
- Consumes: nothing
- Produces: `DEFAULTS` gains `wampRecordBufferSize: 20000`, `wampRecordMaxBytes: 67108864`, `wampRecordPayloadCap: 512`, `wampRecordFullPayloadUris: ['/lol-gameflow/v1/gameflow-phase']`, `wampRecordFile: null`, `cdpConsoleBufferSize: 5000`.

- [x] **Step 1: Write the failing test**

Append to `tests/config.test.js`:

```js
test('the recorder and console defaults are applied', () => {
  const config = validateConfig({});
  assert.equal(config.wampRecordBufferSize, 20000);
  assert.equal(config.wampRecordMaxBytes, 67108864);
  assert.equal(config.wampRecordPayloadCap, 512);
  assert.deepEqual(config.wampRecordFullPayloadUris, ['/lol-gameflow/v1/gameflow-phase']);
  assert.equal(config.wampRecordFile, null);
  assert.equal(config.cdpConsoleBufferSize, 5000);
});

test('recorder sizes must be positive integers', () => {
  assert.throws(() => validateConfig({ wampRecordBufferSize: 0 }), /wampRecordBufferSize/);
  assert.throws(() => validateConfig({ wampRecordMaxBytes: -1 }), /wampRecordMaxBytes/);
  assert.throws(() => validateConfig({ wampRecordPayloadCap: 1.5 }), /wampRecordPayloadCap/);
  assert.throws(() => validateConfig({ cdpConsoleBufferSize: 'big' }), /cdpConsoleBufferSize/);
});

test('wampRecordFullPayloadUris must be an array of paths', () => {
  assert.throws(() => validateConfig({ wampRecordFullPayloadUris: '/x' }), /wampRecordFullPayloadUris/);
  assert.throws(() => validateConfig({ wampRecordFullPayloadUris: [1] }), /wampRecordFullPayloadUris/);
  assert.deepEqual(validateConfig({ wampRecordFullPayloadUris: [] }).wampRecordFullPayloadUris, []);
});

test('wampRecordFile is null or a string path', () => {
  assert.equal(validateConfig({ wampRecordFile: null }).wampRecordFile, null);
  assert.equal(validateConfig({ wampRecordFile: 'C:\\tmp\\rec.ndjson' }).wampRecordFile, 'C:\\tmp\\rec.ndjson');
  assert.throws(() => validateConfig({ wampRecordFile: 7 }), /wampRecordFile/);
});
```

`tests/config.test.js:6` already imports `validateConfig`, so no import change is needed.

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/config.test.js`
Expected: FAIL — `expected 20000, got undefined`

- [x] **Step 3: Extend `src/config.js`**

Add to `DEFAULTS`:

```js
export const DEFAULTS = {
  allowEval: true,
  cdpPort: 8888,
  eventBufferSize: 1000,
  writeAllowlist: [],
  wampRecordBufferSize: 20000,
  wampRecordMaxBytes: 67_108_864,
  wampRecordPayloadCap: 512,
  wampRecordFullPayloadUris: ['/lol-gameflow/v1/gameflow-phase'],
  wampRecordFile: null,
  cdpConsoleBufferSize: 5000
};
```

Add to `validateConfig`, after the existing `eventBufferSize` check and before the `writeAllowlist` check:

```js
  for (const key of ['wampRecordBufferSize', 'wampRecordMaxBytes', 'wampRecordPayloadCap', 'cdpConsoleBufferSize']) {
    if (!Number.isInteger(config[key]) || config[key] < 1) {
      throw new Error(`Config "${key}" must be a positive integer, got ${JSON.stringify(config[key])}`);
    }
  }
  if (
    !Array.isArray(config.wampRecordFullPayloadUris) ||
    config.wampRecordFullPayloadUris.some((u) => typeof u !== 'string')
  ) {
    throw new Error('Config "wampRecordFullPayloadUris" must be an array of URI prefix strings');
  }
  if (config.wampRecordFile !== null && typeof config.wampRecordFile !== 'string') {
    throw new Error(`Config "wampRecordFile" must be a path string or null, got ${typeof config.wampRecordFile}`);
  }
```

- [x] **Step 4: Add the same keys to `config/allowlist.json`**

```json
{
  "allowEval": true,
  "cdpPort": 8888,
  "eventBufferSize": 1000,
  "wampRecordBufferSize": 20000,
  "wampRecordMaxBytes": 67108864,
  "wampRecordPayloadCap": 512,
  "wampRecordFullPayloadUris": ["/lol-gameflow/v1/gameflow-phase"],
  "wampRecordFile": null,
  "cdpConsoleBufferSize": 5000,
  "writeAllowlist": [
    "POST /lol-matchmaking/v1/ready-check/accept",
    "POST /lol-lobby/v2/lobby/matchmaking/search"
  ]
}
```

- [x] **Step 5: Run the full suite**

Run: `npm test`
Expected: 146 passing, 0 failing

- [x] **Step 6: Commit**

```bash
git add src/config.js config/allowlist.json tests/config.test.js
git commit -m "feat: add recorder and console tailer configuration keys"
```

---

### Task 5: Recorder — connect, subscribe, ingest, per-URI stats

**Files:**
- Create: `src/lcu/recorder.js`
- Test: `tests/recorder.test.js`

**Interfaces:**
- Consumes: `createClock` (Task 1); `decodeEventFrame`, `subscribeEndpoint`, `truncateData` (Task 2 / existing `ingest.js`); `TimelineBuffer` (Task 3)
- Produces: `class WampRecorder`
  - `new WampRecorder({ client, config, wsFactory, delay, clock })`
  - `async start({ uris = [], restart = false }) -> { startedAt, mode, uris }`
  - `dump(options) -> { entries, stats, dropped, cursor, remaining, running, startedAt }`
  - `stop(reason = 'tool') -> { stopped, entries }`
  - `statusSnapshot() -> { running, startedAt, mode, uris, entries, bytes, droppedTotal, lastError }`

**Entry shapes** (every entry also carries `ts`, `wallTs`, `seq` from the buffer):

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

This task covers `start` / `open` / `event` / `stop` and the stats. Task 6 adds `close` / `error` / `gap` / `restart` and the reconnect loop.

- [x] **Step 1: Write the failing test**

```js
// tests/recorder.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WampRecorder } from '../src/lcu/recorder.js';

class FakeSocket extends EventEmitter {
  sent = [];
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.emit('close', 1000, Buffer.from('bye'));
  }
}

const CREDENTIALS = { port: 29669, password: 'super-secret-pw' };

function fakeClock(start = 1000) {
  let t = start;
  return { now: () => (t += 1), wall: () => t + 500_000 };
}

function harness({ config = {}, delay } = {}) {
  const sockets = [];
  const factoryArgs = [];
  const calls = { credentials: 0, invalidate: 0, delay: 0 };
  const client = {
    ca: 'RIOT-ROOT-CA-PEM',
    credentials: async () => {
      calls.credentials += 1;
      return CREDENTIALS;
    },
    invalidate: () => {
      calls.invalidate += 1;
    }
  };
  const recorder = new WampRecorder({
    client,
    config: {
      wampRecordBufferSize: 100,
      wampRecordMaxBytes: 1_000_000,
      wampRecordPayloadCap: 512,
      wampRecordFullPayloadUris: ['/lol-gameflow/v1/gameflow-phase'],
      ...config
    },
    clock: fakeClock(),
    wsFactory: (options) => {
      factoryArgs.push(options);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    delay: async (ms) => {
      calls.delay += 1;
      if (delay) await delay(calls.delay, ms);
    }
  });
  return { recorder, sockets, factoryArgs, calls };
}

// The socket only exists after `client.credentials()` resolves, which costs at
// least one microtask tick, so `start()` is awaited before touching sockets[0].
async function started(h, options = {}) {
  const promise = h.recorder.start(options);
  await Promise.resolve();
  h.sockets[0]?.emit('open');
  await promise;
  return h.sockets[0];
}

function frame(uri, data = { ok: true }, endpoint = 'OnJsonApiEvent', eventType = 'Update') {
  return JSON.stringify([8, endpoint, { eventType, uri, data }]);
}

test('start subscribes to the firehose by default', async () => {
  const h = harness();
  const socket = await started(h);
  assert.deepEqual(JSON.parse(socket.sent[0]), [5, 'OnJsonApiEvent']);
  assert.equal(h.recorder.statusSnapshot().mode, 'firehose');
  h.recorder.stop();
});

test('start with uris subscribes per URI', async () => {
  const h = harness();
  const socket = await started(h, { uris: ['/lol-gameflow/v1/gameflow-phase', '/lol-champ-select/v1/session'] });
  assert.deepEqual(socket.sent.map((s) => JSON.parse(s)), [
    [5, 'OnJsonApiEvent_lol-gameflow_v1_gameflow-phase'],
    [5, 'OnJsonApiEvent_lol-champ-select_v1_session']
  ]);
  assert.equal(h.recorder.statusSnapshot().mode, 'uris');
  h.recorder.stop();
});

test('the socket url carries the credentials and the CA', async () => {
  const h = harness();
  await started(h);
  assert.equal(h.factoryArgs[0].url, 'wss://riot:super-secret-pw@127.0.0.1:29669/');
  assert.equal(h.factoryArgs[0].ca, 'RIOT-ROOT-CA-PEM');
  h.recorder.stop();
});

test('a start entry records the recording parameters before any frame', async () => {
  const h = harness();
  await started(h);
  const { entries } = h.recorder.dump({ limit: 100 });
  assert.equal(entries[0].kind, 'start');
  assert.equal(entries[0].mode, 'firehose');
  assert.equal(entries[0].payloadCap, 512);
  assert.equal(entries[1].kind, 'open');
  assert.equal(entries[1].port, 29669);
  h.recorder.stop();
});

test('events are recorded with their endpoint and uri', async () => {
  const h = harness();
  const socket = await started(h);
  socket.emit('message', frame('/lol-gameflow/v1/gameflow-phase', 'ChampSelect'));
  const { entries } = h.recorder.dump({ kinds: ['event'], limit: 100 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].uri, '/lol-gameflow/v1/gameflow-phase');
  assert.equal(entries[0].endpoint, 'OnJsonApiEvent');
  assert.equal(entries[0].data, 'ChampSelect');
  h.recorder.stop();
});

test('nothing is filtered at ingest, so the firehose keeps every URI', async () => {
  const h = harness();
  const socket = await started(h, { uris: ['/lol-gameflow/v1/gameflow-phase'] });
  socket.emit('message', frame('/lol-champ-select/v1/session'));
  socket.emit('message', frame('/lol-gameflow/v1/gameflow-phase'));
  const { entries } = h.recorder.dump({ kinds: ['event'], limit: 100 });
  assert.equal(entries.length, 2, 'ingest must not filter; filtering belongs at dump');
  h.recorder.stop();
});

test('payloads are capped except for the full-payload URIs', async () => {
  const h = harness({ config: { wampRecordPayloadCap: 32 } });
  const socket = await started(h);
  socket.emit('message', frame('/lol-champ-select/v1/session', { blob: 'x'.repeat(500) }));
  socket.emit('message', frame('/lol-gameflow/v1/gameflow-phase', { blob: 'y'.repeat(500) }));

  const { entries } = h.recorder.dump({ kinds: ['event'], limit: 100 });
  const capped = entries.find((e) => e.uri === '/lol-champ-select/v1/session');
  const full = entries.find((e) => e.uri === '/lol-gameflow/v1/gameflow-phase');
  assert.equal(capped.truncated, true);
  assert.equal(full.truncated, false);
  assert.ok(JSON.stringify(full.data).includes('y'.repeat(500)));
  h.recorder.stop();
});

test('per-URI stats survive eviction of the entries themselves', async () => {
  const h = harness({ config: { wampRecordBufferSize: 3 } });
  const socket = await started(h);
  for (let i = 0; i < 10; i += 1) socket.emit('message', frame('/lol-gameflow/v1/gameflow-phase'));

  const { stats, entries } = h.recorder.dump({ kinds: ['event'], limit: 100 });
  assert.ok(entries.length <= 3, 'entries were evicted');
  assert.equal(stats['/lol-gameflow/v1/gameflow-phase'].count, 10, 'the count is cumulative');
  assert.ok(stats['/lol-gameflow/v1/gameflow-phase'].lastTs > stats['/lol-gameflow/v1/gameflow-phase'].firstTs);
  h.recorder.stop();
});

test('stats make socket-alive-but-URI-quiet distinguishable from socket-dead', async () => {
  const h = harness();
  const socket = await started(h);
  socket.emit('message', frame('/lol-gameflow/v1/gameflow-phase'));
  socket.emit('message', frame('/lol-champ-select/v1/session'));
  socket.emit('message', frame('/lol-champ-select/v1/session'));

  const { stats } = h.recorder.dump({ limit: 100 });
  // Gameflow went quiet while champ-select kept flowing: the socket is alive.
  assert.equal(stats['/lol-gameflow/v1/gameflow-phase'].count, 1);
  assert.equal(stats['/lol-champ-select/v1/session'].count, 2);
  assert.ok(stats['/lol-champ-select/v1/session'].lastTs > stats['/lol-gameflow/v1/gameflow-phase'].lastTs);
  h.recorder.stop();
});

test('dump filters by uri prefix without dropping lifecycle entries', async () => {
  const h = harness();
  const socket = await started(h);
  socket.emit('message', frame('/lol-gameflow/v1/gameflow-phase'));
  socket.emit('message', frame('/lol-champ-select/v1/session'));

  const { entries } = h.recorder.dump({ uri: '/lol-gameflow/', limit: 100 });
  const kinds = entries.map((e) => e.kind);
  assert.ok(kinds.includes('start'), 'lifecycle entries survive a uri filter');
  assert.ok(kinds.includes('open'));
  const events = entries.filter((e) => e.kind === 'event');
  assert.equal(events.length, 1);
  assert.equal(events[0].uri, '/lol-gameflow/v1/gameflow-phase');
  h.recorder.stop();
});

test('stop records a stop entry with its reason and leaves the timeline readable', async () => {
  const h = harness();
  const socket = await started(h);
  socket.emit('message', frame('/a'));
  h.recorder.stop();

  const { entries, running } = h.recorder.dump({ limit: 100 });
  assert.equal(running, false);
  assert.equal(entries.at(-1).kind, 'stop');
  assert.equal(entries.at(-1).reason, 'tool');
});

test('a frame arriving on a superseded socket is ignored', async () => {
  const h = harness();
  const socket = await started(h);
  h.recorder.stop();
  socket.emit('message', frame('/a'));
  const events = h.recorder.dump({ kinds: ['event'], limit: 100 }).entries;
  assert.equal(events.length, 0);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/recorder.test.js`
Expected: FAIL — `Cannot find module '../src/lcu/recorder.js'`

- [x] **Step 3: Write the implementation**

```js
// src/lcu/recorder.js
import { WebSocket } from 'ws';
import { createClock } from '../clock.js';
import { redactSecrets } from '../redact.js';
import { decodeEventFrame, subscribeEndpoint, truncateData } from './ingest.js';
import { TimelineBuffer } from './timeline.js';

export const LIFECYCLE_KINDS = ['start', 'stop', 'restart', 'open', 'close', 'error', 'gap'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Injected callbacks and library internals can reject with a non-Error, and
// `undefined.message` in a status field is worse than the value itself.
const errorMessage = (err) => (err instanceof Error ? err.message : String(err));

export class WampRecorder {
  #socket = null;
  #running = false;
  #buffer = null;
  #stats = new Map();
  #startedAt = null;
  #mode = 'firehose';
  #uris = [];
  #lastError = null;
  #knownPasswords = new Set();

  constructor({ client, config, wsFactory, delay = sleep, clock = createClock() }) {
    this.client = client;
    this.config = config;
    this.delay = delay;
    this.clock = clock;
    this.wsFactory =
      wsFactory ??
      (({ url, ca }) => new WebSocket(url, { ca, headers: { 'Content-Type': 'application/json' } }));
  }

  // A recording whose start time cannot be trusted is worse than no recording,
  // because conclusions get drawn from it. So a second start is an error that
  // reports enough for the caller to decide whether discarding is safe, and
  // `restart` drops the old buffer AND the old socket rather than reusing
  // either — keeping old frames has the same misdating problem, quieter.
  async start({ uris = [], restart = false } = {}) {
    if (this.#running && !restart) {
      throw new Error(
        `A recording is already running: started at ${new Date(this.#startedAt).toISOString()} ` +
          `holding ${this.#buffer.length} entries. Dump it first, or pass restart: true to discard it.`
      );
    }

    const previousStartedAt = this.#startedAt;
    const previousEntries = this.#buffer?.length ?? 0;
    const wasRunning = this.#running;
    if (wasRunning) this.#teardown();

    this.#buffer = new TimelineBuffer({
      maxEntries: this.config.wampRecordBufferSize,
      maxBytes: this.config.wampRecordMaxBytes,
      clock: this.clock
    });
    this.#stats = new Map();
    this.#mode = uris.length > 0 ? 'uris' : 'firehose';
    this.#uris = [...uris];
    this.#running = true;
    this.#startedAt = this.clock.wall();

    // The restart entry is the first entry of the NEW buffer, so what was
    // discarded is itself on the record.
    if (wasRunning) {
      this.#buffer.push({ kind: 'restart', previousStartedAt, previousEntries });
    }
    this.#buffer.push({
      kind: 'start',
      uris: this.#uris,
      mode: this.#mode,
      bufferSize: this.config.wampRecordBufferSize,
      maxBytes: this.config.wampRecordMaxBytes,
      payloadCap: this.config.wampRecordPayloadCap
    });

    await this.#connect(0);
    return { startedAt: this.#startedAt, mode: this.#mode, uris: this.#uris };
  }

  async #connect(attempt) {
    const creds = await this.client.credentials();
    if (creds?.password) this.#knownPasswords.add(creds.password);
    // The password-in-URL form is the one verified against the live client.
    // Never log this URL.
    const url = `wss://riot:${creds.password}@127.0.0.1:${creds.port}/`;
    const socket = this.wsFactory({ url, ca: this.client.ca });
    this.#socket = socket;

    socket.on('message', (raw) => this.#ingest(socket, raw));
    socket.on('error', (err) => {
      this.#record(socket, { kind: 'error', message: this.#redact(`socket error: ${err?.code ?? errorMessage(err)}`) });
      this.#lastError = this.#redact(`socket error: ${err?.code ?? errorMessage(err)}`);
    });

    try {
      await new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
        // A socket can close without ever emitting 'error' when the client
        // exits mid-handshake. Without this the promise never settles and the
        // MCP tool call hangs forever.
        socket.once('close', () => reject(new Error('recorder socket closed before open')));
      });
      if (!this.#running || this.#socket !== socket) {
        throw new Error('recorder stopped before the socket opened');
      }
      for (const endpoint of this.#subscribeEndpoints()) {
        socket.send(JSON.stringify([5, endpoint]));
      }
    } catch (err) {
      if (this.#socket === socket) this.#socket = null;
      this.#closeQuietly(socket);
      throw err;
    }

    this.#buffer.push({ kind: 'open', port: creds.port, attempt });
    // Registered only now that the socket is live: before the handshake
    // completes a close *is* the failure that rejects the promise above.
    socket.on('close', (code, reason) => this.#onClose(socket, code, reason));
  }

  #subscribeEndpoints() {
    return this.#mode === 'firehose' ? ['OnJsonApiEvent'] : this.#uris.map(subscribeEndpoint);
  }

  // Placeholder until Task 6 installs the reconnect loop.
  #onClose(socket, code, reason) {
    this.#record(socket, {
      kind: 'close',
      code: code ?? null,
      reason: reason ? String(reason) : '',
      wasClean: code === 1000
    });
  }

  #record(socket, entry) {
    // A superseded or stopped socket keeps emitting for a while. Without this
    // identity check its frames land in the buffer too, so one LCU event is
    // recorded once per orphaned socket and stop() does not stop the recorder.
    if (!this.#running || socket !== this.#socket) return;
    this.#buffer.push(entry);
  }

  #ingest(socket, raw) {
    if (!this.#running || socket !== this.#socket) return;
    const event = decodeEventFrame(raw);
    if (event === null) return;

    // Ground truth needs "a frame arrived on this URI at time T"; the payload
    // matters only for the handful of URIs under active correlation. Capping
    // the rest is what makes the firehose affordable.
    const cap = this.#payloadCapFor(event.uri);
    const { data, truncated } = truncateData(event.data, cap);
    const stored = this.#buffer.push({
      kind: 'event',
      uri: event.uri,
      eventType: event.eventType,
      endpoint: event.endpoint,
      data,
      truncated
    });
    this.#countUri(event.uri, stored.ts);
  }

  #payloadCapFor(uri) {
    const full = this.config.wampRecordFullPayloadUris ?? [];
    const exempt = typeof uri === 'string' && full.some((prefix) => uri.startsWith(prefix));
    return exempt ? Infinity : this.config.wampRecordPayloadCap;
  }

  // Held outside the ring buffer so they survive eviction: under a firehose an
  // evicted event is otherwise indistinguishable from an absent one.
  #countUri(uri, ts) {
    if (typeof uri !== 'string') return;
    const current = this.#stats.get(uri);
    if (current === undefined) {
      this.#stats.set(uri, { count: 1, firstTs: ts, lastTs: ts });
      return;
    }
    current.count += 1;
    current.lastTs = ts;
  }

  #redact(message) {
    if (typeof message !== 'string' || this.#knownPasswords.size === 0) return message;
    return redactSecrets(message, [...this.#knownPasswords]);
  }

  #closeQuietly(socket) {
    try {
      socket?.close();
    } catch {
      // already gone
    }
  }

  #teardown() {
    this.#running = false;
    const socket = this.#socket;
    this.#socket = null;
    this.#closeQuietly(socket);
  }

  dump({ uri = null, since = null, until = null, kinds = null, limit = 100, cursor = 0 } = {}) {
    if (this.#buffer === null) {
      return { entries: [], stats: {}, dropped: 0, cursor: 0, remaining: 0, running: false, startedAt: null };
    }
    // A uri filter narrows events only. Lifecycle entries carry no uri and are
    // usually the answer, so only an explicit `kinds` can exclude them.
    const predicate = uri === null ? null : (e) => typeof e.uri !== 'string' || e.uri.startsWith(uri);
    const page = this.#buffer.select({ cursor, since, until, limit, kinds, predicate });
    return {
      ...page,
      stats: Object.fromEntries(this.#stats),
      running: this.#running,
      startedAt: this.#startedAt
    };
  }

  stop(reason = 'tool') {
    if (!this.#running) return { stopped: false, entries: this.#buffer?.length ?? 0 };
    const socket = this.#socket;
    this.#running = false;
    this.#socket = null;
    this.#closeQuietly(socket);
    // Pushed after #running is false so the identity-checked #record path
    // cannot also fire for the close this triggers.
    this.#buffer.push({ kind: 'stop', reason });
    return { stopped: true, entries: this.#buffer.length };
  }

  statusSnapshot() {
    return {
      running: this.#running,
      startedAt: this.#startedAt,
      mode: this.#mode,
      uris: [...this.#uris],
      entries: this.#buffer?.length ?? 0,
      bytes: this.#buffer?.bytes ?? 0,
      droppedTotal: this.#buffer?.droppedTotal ?? 0,
      lastError: this.#lastError
    };
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test tests/recorder.test.js`
Expected: PASS, 12 tests

- [x] **Step 5: Run the full suite**

Run: `npm test`
Expected: 158 passing, 0 failing

- [x] **Step 6: Commit**

```bash
git add src/lcu/recorder.js tests/recorder.test.js
git commit -m "feat: add the WAMP recorder with per-URI stats and a lifecycle timeline"
```

---

### Task 6: Recorder — close codes, reconnect and gaps

**Files:**
- Modify: `src/lcu/recorder.js`
- Test: `tests/recorder.test.js` (append)

**Interfaces:**
- Consumes: everything from Task 5
- Produces: `backoffDelay(attempt) -> number` exported from `src/lcu/recorder.js`; `close` / `error` / `gap` entries in the timeline

**Why this is the point of the whole feature:** "the socket died" is only an answer if the close code sits next to the last event that got through. Absence of events and a dead socket must be distinguishable in one timeline.

- [x] **Step 1: Write the failing test**

Append to `tests/recorder.test.js`:

```js
import { backoffDelay } from '../src/lcu/recorder.js'; // add to the existing import line

test('backoff grows and is capped', () => {
  assert.equal(backoffDelay(0), 1000);
  assert.equal(backoffDelay(1), 2000);
  assert.equal(backoffDelay(10), 30000);
});

test('a close records its code next to the last event that got through', async () => {
  const h = harness({ delay: async () => {} });
  const socket = await started(h);
  socket.emit('message', frame('/lol-gameflow/v1/gameflow-phase'));
  socket.emit('close', 1006, Buffer.from('abnormal'));
  await new Promise((r) => setImmediate(r));

  const { entries } = h.recorder.dump({ limit: 100 });
  const closeAt = entries.findIndex((e) => e.kind === 'close');
  const lastEventAt = entries.map((e) => e.kind).lastIndexOf('event');
  assert.ok(closeAt > lastEventAt, 'the close must follow the last delivered event');
  assert.equal(entries[closeAt].code, 1006);
  assert.equal(entries[closeAt].reason, 'abnormal');
  assert.equal(entries[closeAt].wasClean, false);
  h.recorder.stop();
});

test('a clean close is marked as such', async () => {
  const h = harness({ delay: async () => {} });
  const socket = await started(h);
  socket.emit('close', 1000, Buffer.from(''));
  await new Promise((r) => setImmediate(r));
  const close = h.recorder.dump({ kinds: ['close'], limit: 10 }).entries[0];
  assert.equal(close.wasClean, true);
  h.recorder.stop();
});

test('reconnect reopens, invalidates the cached port, and records the gap', async () => {
  const h = harness({ delay: async () => {} });
  const first = await started(h);

  first.emit('close', 1006, Buffer.from('dead'));
  // Let the reconnect loop run: delay resolves immediately, then the new
  // socket needs its open event.
  await new Promise((r) => setImmediate(r));
  h.sockets[1]?.emit('open');
  await new Promise((r) => setImmediate(r));

  assert.equal(h.sockets.length, 2, 'a new socket was opened');
  assert.equal(h.calls.invalidate, 1, 'the cached LCU port was invalidated for the restart case');

  const kinds = h.recorder.dump({ limit: 100 }).entries.map((e) => e.kind);
  assert.deepEqual(kinds, ['start', 'open', 'close', 'open', 'gap']);

  const gap = h.recorder.dump({ kinds: ['gap'], limit: 10 }).entries[0];
  assert.ok(gap.durationMs >= 0);
  assert.ok(gap.sinceTs > 0);
  h.recorder.stop();
});

test('the recorder resubscribes after a reconnect', async () => {
  const h = harness({ delay: async () => {} });
  const first = await started(h, { uris: ['/lol-gameflow/v1/gameflow-phase'] });
  first.emit('close', 1006, Buffer.from(''));
  await new Promise((r) => setImmediate(r));
  h.sockets[1]?.emit('open');
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(JSON.parse(h.sockets[1].sent[0]), [5, 'OnJsonApiEvent_lol-gameflow_v1_gameflow-phase']);
  h.recorder.stop();
});

test('stop orphans an in-flight reconnect loop', async () => {
  let release;
  const h = harness({ delay: () => new Promise((r) => { release = r; }) });
  const first = await started(h);
  first.emit('close', 1006, Buffer.from(''));
  await new Promise((r) => setImmediate(r));

  h.recorder.stop();
  release();
  await new Promise((r) => setImmediate(r));

  assert.equal(h.sockets.length, 1, 'no socket was opened after stop');
});

test('a password never reaches the timeline through an error entry', async () => {
  const h = harness({ delay: async () => {} });
  const socket = await started(h);
  socket.emit('error', new Error('connect failed for wss://riot:super-secret-pw@127.0.0.1:29669/'));
  await new Promise((r) => setImmediate(r));

  const text = JSON.stringify(h.recorder.dump({ limit: 100 }));
  assert.ok(!text.includes('super-secret-pw'), 'the password must never be stored');
  assert.ok(text.includes('***'));
  h.recorder.stop();
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/recorder.test.js`
Expected: FAIL — `backoffDelay is not a function`, and the reconnect test finds only one socket

- [x] **Step 3: Give `backoffDelay` one home**

`src/lcu/events.js` already exports a `backoffDelay`, and the recorder and the console tailer both need the same curve. Three copies is two too many, but `src/lcu/events.js` is the wrong home for something `src/cdp/` must import.

Create `src/backoff.js`:

```js
// Shared by the event tap, the WAMP recorder and the CDP console tailer.
export function backoffDelay(attempt) {
  return Math.min(30000, 1000 * 2 ** attempt);
}
```

In `src/lcu/events.js`, delete the local definition and re-export so its existing consumers — including `tests/events-tap.test.js`, which imports `backoffDelay` from there — keep working untouched:

```js
export { backoffDelay } from '../backoff.js';
```

Confirm with `node --test tests/events-tap.test.js` before continuing: it must stay green without being edited.

- [x] **Step 4: Replace the `#onClose` placeholder with the reconnect loop**

Import the shared helper at the top of `src/lcu/recorder.js`:

```js
import { backoffDelay } from '../backoff.js';
```

and re-export it, since `tests/recorder.test.js` imports it from here:

```js
export { backoffDelay };
```

Add two private fields to the class:

```js
  // Identity token for the one reconnect loop allowed to run. `null` means no
  // loop owns the recorder. A token rather than a boolean so stop() can orphan
  // an in-flight loop by clearing the field, without a later start() being
  // locked out and without the orphan clearing a flag its successor holds.
  #reconnectOwner = null;
  #lastCloseTs = null;
```

Replace `#onClose` with:

```js
  #onClose(socket, code, reason) {
    if (!this.#running || socket !== this.#socket) return;
    const stored = this.#buffer.push({
      kind: 'close',
      code: code ?? null,
      reason: reason ? String(reason) : '',
      wasClean: code === 1000
    });
    this.#lastCloseTs = stored.ts;
    this.#socket = null;
    // Fire and forget: no MCP call is waiting on this.
    this.#reconnect();
  }

  async #reconnect() {
    if (this.#reconnectOwner !== null) return;
    const owner = Symbol('reconnect');
    this.#reconnectOwner = owner;
    const sinceTs = this.#lastCloseTs;
    try {
      for (let attempt = 0; this.#running && this.#reconnectOwner === owner; attempt += 1) {
        await this.delay(backoffDelay(attempt));
        if (!this.#running || this.#reconnectOwner !== owner) return;
        try {
          // The port changes when the client restarts, so the cached
          // credentials must not be trusted across a reconnect.
          this.client.invalidate?.();
          await this.#connect(attempt + 1);
        } catch (err) {
          this.#lastError = this.#redact(`reconnect failed: ${errorMessage(err)}`);
          this.#buffer.push({ kind: 'error', message: this.#lastError });
          continue;
        }
        this.#buffer.push({
          kind: 'gap',
          durationMs: sinceTs === null ? null : this.clock.now() - sinceTs,
          sinceTs
        });
        return;
      }
    } finally {
      if (this.#reconnectOwner === owner) this.#reconnectOwner = null;
    }
  }
```

Update `stop()` and `#teardown()` to orphan the loop by adding `this.#reconnectOwner = null;` immediately after `this.#running = false;` in both.

- [x] **Step 5: Run test to verify it passes**

Run: `node --test tests/recorder.test.js`
Expected: PASS, 19 tests

- [x] **Step 6: Run the full suite**

Run: `npm test`
Expected: 165 passing, 0 failing

- [x] **Step 7: Commit**

```bash
git add src/backoff.js src/lcu/events.js src/lcu/recorder.js tests/recorder.test.js
git commit -m "feat: record socket close codes, reconnects and timeline gaps"
```

---

### Task 7: Recorder tools and wiring

**Files:**
- Create: `src/tools/recorder.js`
- Modify: `src/index.js`
- Modify: `src/tools/status.js`
- Test: `tests/tools-recorder.test.js`
- Modify: `tests/tools-status.test.js`

**Interfaces:**
- Consumes: `WampRecorder` (Tasks 5-6), `LIFECYCLE_KINDS`
- Produces: `registerRecorderTools(server, ctx)`; `ctx.recorder`

- [x] **Step 1: Write the failing test**

```js
// tests/tools-recorder.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerRecorderTools } from '../src/tools/recorder.js';

function ctxWith(recorder) {
  return { recorder, config: { configPath: 'config/allowlist.json' }, secrets: () => [] };
}

// Captures the handlers the tools register, so they can be called directly.
function register(recorder) {
  const handlers = new Map();
  const server = { registerTool: (name, _meta, handler) => handlers.set(name, handler) };
  registerRecorderTools(server, ctxWith(recorder));
  return handlers;
}

const parse = (result) => JSON.parse(result.content[0].text);

test('start passes uris and restart through and reports the mode', async () => {
  const calls = [];
  const handlers = register({
    start: async (options) => {
      calls.push(options);
      return { startedAt: 1700000000000, mode: 'uris', uris: options.uris };
    }
  });
  const result = await handlers.get('lol_wamp_record_start')({ uris: ['/lol-gameflow/v1/gameflow-phase'] });
  assert.deepEqual(calls[0], { uris: ['/lol-gameflow/v1/gameflow-phase'], restart: false });
  assert.equal(parse(result).mode, 'uris');
});

test('start defaults to the firehose when no uris are given', async () => {
  const calls = [];
  const handlers = register({
    start: async (options) => {
      calls.push(options);
      return { startedAt: 1, mode: 'firehose', uris: [] };
    }
  });
  await handlers.get('lol_wamp_record_start')({});
  assert.deepEqual(calls[0], { uris: [], restart: false });
});

test('a second start surfaces the recorder error rather than succeeding', async () => {
  const handlers = register({
    start: async () => {
      throw new Error('A recording is already running: started at X holding 12 entries.');
    }
  });
  const result = await handlers.get('lol_wamp_record_start')({});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /already running/);
  assert.match(result.content[0].text, /12 entries/);
});

test('dump forwards every filter and returns stats', async () => {
  const calls = [];
  const handlers = register({
    dump: (options) => {
      calls.push(options);
      return { entries: [], stats: { '/a': { count: 3 } }, dropped: 0, cursor: 0, remaining: 0, running: true, startedAt: 1 };
    }
  });
  const result = await handlers.get('lol_wamp_record_dump')({
    uri: '/lol-gameflow/',
    since: 100,
    until: 200,
    kinds: ['event'],
    limit: 50,
    cursor: 7
  });
  assert.deepEqual(calls[0], {
    uri: '/lol-gameflow/',
    since: 100,
    until: 200,
    kinds: ['event'],
    limit: 50,
    cursor: 7
  });
  assert.equal(parse(result).stats['/a'].count, 3);
});

test('stop reports how many entries remain readable', async () => {
  const handlers = register({ stop: () => ({ stopped: true, entries: 42 }) });
  assert.equal(parse(await handlers.get('lol_wamp_record_stop')({})).entries, 42);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/tools-recorder.test.js`
Expected: FAIL — `Cannot find module '../src/tools/recorder.js'`

- [x] **Step 3: Write `src/tools/recorder.js`**

```js
import { z } from 'zod';
import { LIFECYCLE_KINDS } from '../lcu/recorder.js';
import { guard, ok } from './result.js';

const KINDS = ['event', ...LIFECYCLE_KINDS];

export function registerRecorderTools(server, ctx) {
  server.registerTool(
    'lol_wamp_record_start',
    {
      title: 'Start recording LCU WAMP traffic',
      description:
        'Open a second WAMP socket to the LCU, independent of lol_events_*, and record every ' +
        'frame plus the socket lifecycle (open, close with its code, error, reconnect gap) into ' +
        'one timeline. Defaults to the firehose, which is what lets you tell "the socket died" ' +
        '(every URI goes quiet at once) from "nothing happened" (one URI quiet, others flowing). ' +
        'Passing uris subscribes per URI instead, which reproduces what a page-side plugin sees ' +
        'but cannot distinguish those two cases. Starting while a recording is already running ' +
        'is an error: pass restart to discard the old one.',
      inputSchema: {
        uris: z
          .array(z.string().startsWith('/'))
          .optional()
          .describe('subscribe per URI instead of the firehose, e.g. ["/lol-gameflow/v1/gameflow-phase"]'),
        restart: z.boolean().optional().describe('discard a running recording and start a fresh one')
      }
    },
    guard(async ({ uris = [], restart = false }) => ok(await ctx.recorder.start({ uris, restart })), ctx)
  );

  server.registerTool(
    'lol_wamp_record_dump',
    {
      title: 'Dump the recorded WAMP timeline',
      description:
        'Return the recorded timeline plus per-URI stats. "stats" is cumulative since the ' +
        'recording started and survives buffer eviction, so a URI that fired and was evicted is ' +
        'still distinguishable from one that never fired. A non-zero "dropped" means entries ' +
        'after your cursor were evicted. Lifecycle entries survive a uri filter; only "kinds" ' +
        'can exclude them. Times are epoch milliseconds, comparable with the page clock.',
      inputSchema: {
        uri: z.string().optional().describe('URI prefix filter, applied to event entries only'),
        since: z.number().optional().describe('lower bound on ts, epoch milliseconds'),
        until: z.number().optional().describe('upper bound on ts, epoch milliseconds'),
        kinds: z.array(z.enum(KINDS)).optional().describe('restrict to these entry kinds'),
        limit: z.number().int().min(1).max(2000).optional().describe('max entries, default 100'),
        cursor: z.number().int().min(0).optional().describe('seq cursor from a previous dump')
      }
    },
    guard(
      async ({ uri = null, since = null, until = null, kinds = null, limit = 100, cursor = 0 }) =>
        ok(ctx.recorder.dump({ uri, since, until, kinds, limit, cursor })),
      ctx
    )
  );

  server.registerTool(
    'lol_wamp_record_stop',
    {
      title: 'Stop recording LCU WAMP traffic',
      description: 'Close the recorder socket. The recorded timeline stays readable with lol_wamp_record_dump.',
      inputSchema: {}
    },
    guard(async () => ok(ctx.recorder.stop('tool')), ctx)
  );
}
```

- [x] **Step 4: Wire into `src/index.js`**

Add imports:

```js
import { WampRecorder } from './lcu/recorder.js';
import { registerRecorderTools } from './tools/recorder.js';
```

In `buildContext`, after `const cdp = ...`:

```js
  const recorder = new WampRecorder({ client: lcu, config });
```

Add `recorder` to the returned object, and in `createServer` add:

```js
  registerRecorderTools(server, ctx);
```

- [x] **Step 5: Add recorder state to `src/tools/status.js`**

Add `recorder: ctx.recorder.statusSnapshot(),` to the `ok({...})` object, after `events:`.

- [x] **Step 6: Update the exact-tool-set assertion**

The expected list at `tests/tools-status.test.js:37-45` is sorted alphabetically. Append, keeping that order:

```js
    'lol_status',
    'lol_wamp_record_dump',
    'lol_wamp_record_start',
    'lol_wamp_record_stop'
```

Also add `recorder` to any assertion enumerating `lol_status` keys.

- [x] **Step 7: Run the full suite**

Run: `npm test`
Expected: 170 passing, 0 failing

- [x] **Step 8: Verify the password stays out of status**

Run: `node --test --test-name-pattern="never leaks the password"`
Expected: PASS

- [x] **Step 9: Commit**

```bash
git add src/tools/recorder.js src/index.js src/tools/status.js tests/tools-recorder.test.js tests/tools-status.test.js
git commit -m "feat: expose the WAMP recorder as MCP tools"
```

---

## Phase 2 — CDP console tailer (Tasks 8-11)

### Task 8: CDP event dispatch

**Files:**
- Modify: `src/cdp/client.js`
- Test: `tests/cdp-client.test.js` (append)

**Interfaces:**
- Consumes: nothing
- Produces on `CdpClient`:
  - `on(method, handler) -> unsubscribe()` — handler receives the event `params`
  - `onClose(handler) -> unsubscribe()` — fired when the live socket closes

**Why:** `#handleMessage` currently drops every unsolicited event (`src/cdp/client.js:75`). Nothing can subscribe to `Runtime.consoleAPICalled` until this exists.

- [x] **Step 1: Write the failing test**

Append to `tests/cdp-client.test.js`:

```js
test('on delivers CDP events to subscribers', async () => {
  const { client, sockets } = harness();
  await client.attach();
  const seen = [];
  client.on('Runtime.consoleAPICalled', (params) => seen.push(params));

  sockets[0].emit('message', JSON.stringify({
    method: 'Runtime.consoleAPICalled',
    params: { type: 'log', args: [{ type: 'string', value: 'hi' }] }
  }));

  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'log');
  client.close();
});

test('an event with no subscriber is ignored, not thrown', async () => {
  const { client, sockets } = harness();
  await client.attach();
  sockets[0].emit('message', JSON.stringify({ method: 'Runtime.somethingElse', params: {} }));
  assert.equal(client.statusSnapshot().attached, true);
  client.close();
});

test('on returns an unsubscribe that stops delivery', async () => {
  const { client, sockets } = harness();
  await client.attach();
  const seen = [];
  const off = client.on('Runtime.exceptionThrown', (p) => seen.push(p));
  sockets[0].emit('message', JSON.stringify({ method: 'Runtime.exceptionThrown', params: { a: 1 } }));
  off();
  sockets[0].emit('message', JSON.stringify({ method: 'Runtime.exceptionThrown', params: { a: 2 } }));
  assert.equal(seen.length, 1);
  client.close();
});

test('a throwing subscriber does not break the message loop', async () => {
  const { client, sockets } = harness();
  await client.attach();
  const seen = [];
  client.on('Runtime.consoleAPICalled', () => { throw new Error('subscriber blew up'); });
  client.on('Runtime.consoleAPICalled', (p) => seen.push(p));
  sockets[0].emit('message', JSON.stringify({ method: 'Runtime.consoleAPICalled', params: { type: 'log' } }));
  assert.equal(seen.length, 1, 'a later subscriber still receives the event');
  client.close();
});

test('onClose fires when the live socket closes', async () => {
  const { client, sockets } = harness();
  await client.attach();
  let closed = 0;
  client.onClose(() => { closed += 1; });
  sockets[0].close();
  assert.equal(closed, 1);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/cdp-client.test.js`
Expected: FAIL — `client.on is not a function`

- [x] **Step 3: Implement the dispatch in `src/cdp/client.js`**

Add two private fields next to the existing ones:

```js
  #listeners = new Map();
  #closeListeners = new Set();
```

Add these methods after `send()`:

```js
  // CDP events arrive unsolicited, with a `method` and no `id`. Without a
  // dispatch they are dropped, which is why nothing could tail the console.
  on(method, handler) {
    const list = this.#listeners.get(method) ?? new Set();
    list.add(handler);
    this.#listeners.set(method, list);
    return () => list.delete(handler);
  }

  onClose(handler) {
    this.#closeListeners.add(handler);
    return () => this.#closeListeners.delete(handler);
  }

  #emit(handlers, arg) {
    for (const handler of handlers) {
      try {
        handler(arg);
      } catch {
        // A subscriber's failure must not stop the socket's message loop or
        // rob every later subscriber of the event.
      }
    }
  }
```

Replace the early return in `#handleMessage`:

```js
    if (message.id === undefined) {
      const handlers = this.#listeners.get(message.method);
      if (handlers) this.#emit(handlers, message.params ?? {});
      return;
    }
```

In `#connect`, inside the existing `socket.on('close', ...)` handler, add after the pending-rejection loop:

```js
      this.#emit(this.#closeListeners, undefined);
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test tests/cdp-client.test.js`
Expected: PASS, 15 tests

- [x] **Step 5: Run the full suite**

Run: `npm test`
Expected: 175 passing, 0 failing

- [x] **Step 6: Commit**

```bash
git add src/cdp/client.js tests/cdp-client.test.js
git commit -m "feat: dispatch unsolicited CDP events to subscribers"
```

---

### Task 9: Console tailer — buffering and redaction

**Files:**
- Create: `src/cdp/console.js`
- Test: `tests/cdp-console.test.js`

**Interfaces:**
- Consumes: `CdpClient.on` / `onClose` (Task 8), `TimelineBuffer` (Task 3), `createClock` (Task 1), `redactSecrets`
- Produces: `class ConsoleTailer`
  - `new ConsoleTailer({ cdp, config, secrets, clock, delay })`
  - `async start() -> { startedAt, targetId }`
  - `tail(options) -> { entries, cursor, dropped, remaining, running, attached, targetId, startedAt }` — **throws when not running**
  - `stop() -> { stopped, entries }`
  - `statusSnapshot()`
  - `renderArg(remoteObject) -> string` exported separately for testing

**Entry shapes** (plus `ts`, `wallTs`, `seq` from the buffer):

```
{ kind:'console',   pageTs, targetId, level, args, stackTop, url }
{ kind:'exception', pageTs, targetId, level:'error', text, description, stackTop, url }
{ kind:'reattach',  previousTargetId, targetId, gapMs }
```

An exception carries `level: 'error'` so that a `level` filter does not hide the
loudest evidence in the buffer.

- [x] **Step 1: Write the failing test**

```js
// tests/cdp-console.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConsoleTailer, renderArg } from '../src/cdp/console.js';

function fakeClock(start = 1000) {
  let t = start;
  return { now: () => (t += 1), wall: () => t + 500_000 };
}

function fakeCdp() {
  const listeners = new Map();
  const closeListeners = new Set();
  const sent = [];
  return {
    sent,
    target: { id: 'PAGE-1' },
    emit(method, params) {
      for (const h of listeners.get(method) ?? []) h(params);
    },
    emitClose() {
      for (const h of closeListeners) h();
    },
    on(method, handler) {
      const list = listeners.get(method) ?? new Set();
      list.add(handler);
      listeners.set(method, list);
      return () => list.delete(handler);
    },
    onClose(handler) {
      closeListeners.add(handler);
      return () => closeListeners.delete(handler);
    },
    async attach() {},
    async send(method, params) {
      sent.push({ method, params });
      return {};
    },
    statusSnapshot() {
      return { attached: true, targetId: this.target.id };
    },
    close() {}
  };
}

function harness({ secrets = () => [], config = {} } = {}) {
  const cdp = fakeCdp();
  const tailer = new ConsoleTailer({
    cdp,
    config: { cdpConsoleBufferSize: 100, ...config },
    secrets,
    clock: fakeClock(),
    delay: async () => {}
  });
  return { cdp, tailer };
}

const consoleEvent = (overrides = {}) => ({
  type: 'log',
  timestamp: 1_700_000_000_123,
  args: [{ type: 'string', value: 'hello' }],
  stackTrace: { callFrames: [{ functionName: 'onPhase', url: 'https://riot:0/plugin.js', lineNumber: 41 }] },
  ...overrides
});

test('start enables Runtime and reports the target', async () => {
  const { cdp, tailer } = harness();
  const result = await tailer.start();
  assert.ok(cdp.sent.some((s) => s.method === 'Runtime.enable'));
  assert.equal(result.targetId, 'PAGE-1');
  tailer.stop();
});

test('tail before start is an error, not an empty success', async () => {
  const { tailer } = harness();
  assert.throws(() => tailer.tail({}), /not running/i);
});

test('tail after stop is an error too', async () => {
  const { tailer } = harness();
  await tailer.start();
  tailer.stop();
  assert.throws(() => tailer.tail({}), /not running/i);
});

test('a console call is buffered with both clocks', async () => {
  const { cdp, tailer } = harness();
  await tailer.start();
  cdp.emit('Runtime.consoleAPICalled', consoleEvent());

  const { entries } = tailer.tail({ limit: 100 });
  const entry = entries.find((e) => e.kind === 'console');
  assert.equal(entry.level, 'log');
  assert.equal(entry.args, 'hello');
  assert.equal(entry.pageTs, 1_700_000_000_123, 'the page clock is preserved');
  assert.ok(typeof entry.ts === 'number', 'our anchored clock is recorded too');
  assert.ok(typeof entry.wallTs === 'number', 'and our raw wall clock');
  assert.equal(entry.targetId, 'PAGE-1');
  assert.match(entry.stackTop, /onPhase/);
  tailer.stop();
});

test('an exception is buffered with its description', async () => {
  const { cdp, tailer } = harness();
  await tailer.start();
  cdp.emit('Runtime.exceptionThrown', {
    timestamp: 1_700_000_000_500,
    exceptionDetails: {
      text: 'Uncaught',
      exception: { description: 'TypeError: socket is null' },
      stackTrace: { callFrames: [{ functionName: 'reconnect', url: 'p.js', lineNumber: 7 }] }
    }
  });
  const entry = tailer.tail({ limit: 100 }).entries.find((e) => e.kind === 'exception');
  assert.equal(entry.description, 'TypeError: socket is null');
  assert.equal(entry.pageTs, 1_700_000_000_500);
  tailer.stop();
});

test('the LCU password is redacted before it enters the buffer', async () => {
  const { cdp, tailer } = harness({ secrets: () => ['super-secret-pw'] });
  await tailer.start();
  cdp.emit('Runtime.consoleAPICalled', consoleEvent({
    args: [{ type: 'string', value: 'connecting to wss://riot:super-secret-pw@127.0.0.1:29669/' }]
  }));

  const text = JSON.stringify(tailer.tail({ limit: 100 }));
  assert.ok(!text.includes('super-secret-pw'), 'the password must never be stored');
  assert.ok(text.includes('***'));
  tailer.stop();
});

test('a password in an exception description is redacted too', async () => {
  const { cdp, tailer } = harness({ secrets: () => ['super-secret-pw'] });
  await tailer.start();
  cdp.emit('Runtime.exceptionThrown', {
    timestamp: 1,
    exceptionDetails: { text: 'failed on wss://riot:super-secret-pw@127.0.0.1:1/', exception: {} }
  });
  assert.ok(!JSON.stringify(tailer.tail({ limit: 100 })).includes('super-secret-pw'));
  tailer.stop();
});

test('level filters console entries', async () => {
  const { cdp, tailer } = harness();
  await tailer.start();
  cdp.emit('Runtime.consoleAPICalled', consoleEvent({ type: 'log' }));
  cdp.emit('Runtime.consoleAPICalled', consoleEvent({ type: 'error' }));
  const { entries } = tailer.tail({ level: 'error', limit: 100 });
  assert.equal(entries.filter((e) => e.kind === 'console').length, 1);
  tailer.stop();
});

test('an uncaught exception survives a level:error filter', async () => {
  const { cdp, tailer } = harness();
  await tailer.start();
  cdp.emit('Runtime.consoleAPICalled', consoleEvent({ type: 'log' }));
  cdp.emit('Runtime.exceptionThrown', {
    timestamp: 1,
    exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: socket is null' } }
  });
  const { entries } = tailer.tail({ level: 'error', limit: 100 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'exception', 'filtering for errors must not hide exceptions');
  tailer.stop();
});

test('text matches case-insensitively across args and exception text', async () => {
  const { cdp, tailer } = harness();
  await tailer.start();
  cdp.emit('Runtime.consoleAPICalled', consoleEvent({ args: [{ type: 'string', value: 'Socket CLOSED' }] }));
  cdp.emit('Runtime.consoleAPICalled', consoleEvent({ args: [{ type: 'string', value: 'all good' }] }));
  const { entries } = tailer.tail({ text: 'socket closed', limit: 100 });
  assert.equal(entries.length, 1);
  tailer.stop();
});

test('renderArg prefers value, then description, then type', () => {
  assert.equal(renderArg({ type: 'string', value: 'hi' }), 'hi');
  assert.equal(renderArg({ type: 'number', value: 42 }), '42');
  assert.equal(renderArg({ type: 'object', description: 'Error: boom' }), 'Error: boom');
  assert.equal(renderArg({ type: 'object', subtype: 'null' }), 'object');
  assert.equal(renderArg({ type: 'undefined' }), 'undefined');
});

test('renderArg caps a very long argument', () => {
  const rendered = renderArg({ type: 'string', value: 'x'.repeat(5000) });
  assert.ok(rendered.length < 600, `rendered length ${rendered.length} should be capped`);
  assert.match(rendered, /truncated/);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/cdp-console.test.js`
Expected: FAIL — `Cannot find module '../src/cdp/console.js'`

- [x] **Step 3: Write the implementation**

```js
// src/cdp/console.js
import { backoffDelay } from '../backoff.js';
import { createClock } from '../clock.js';
import { redactSecrets } from '../redact.js';
import { TimelineBuffer } from '../lcu/timeline.js';

export const ARG_CAP = 512;
export const ARGS_CAP = 2048;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cap(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… (truncated from ${text.length})`;
}

// consoleAPICalled delivers RemoteObjects. Deep-serialising them is expensive
// on a hot log path, so take the cheapest faithful representation available.
export function renderArg(arg) {
  if (arg === null || typeof arg !== 'object') return String(arg);
  if ('value' in arg) {
    const raw = typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value);
    return cap(String(raw), ARG_CAP);
  }
  if (typeof arg.description === 'string') return cap(arg.description, ARG_CAP);
  return String(arg.type ?? 'unknown');
}

function stackTop(stackTrace) {
  const frame = stackTrace?.callFrames?.[0];
  if (!frame) return null;
  const where = `${frame.url ?? ''}:${frame.lineNumber ?? '?'}`;
  return `${frame.functionName || '(anonymous)'} @ ${where}`;
}

export class ConsoleTailer {
  #buffer = null;
  #running = false;
  #startedAt = null;
  #targetId = null;
  #unsubscribe = [];
  #reconnectOwner = null;
  #lastError = null;

  constructor({ cdp, config, secrets = () => [], clock = createClock(), delay = sleep }) {
    this.cdp = cdp;
    this.config = config;
    this.secrets = secrets;
    this.clock = clock;
    this.delay = delay;
  }

  async start() {
    if (this.#running) {
      return { startedAt: this.#startedAt, targetId: this.#targetId, alreadyRunning: true };
    }
    this.#buffer = new TimelineBuffer({
      maxEntries: this.config.cdpConsoleBufferSize,
      clock: this.clock
    });
    this.#running = true;
    this.#startedAt = this.clock.wall();
    this.#subscribe();
    await this.#enable();
    return { startedAt: this.#startedAt, targetId: this.#targetId };
  }

  #subscribe() {
    this.#unsubscribe = [
      this.cdp.on('Runtime.consoleAPICalled', (params) => this.#onConsole(params)),
      this.cdp.on('Runtime.exceptionThrown', (params) => this.#onException(params)),
      this.cdp.onClose(() => this.#onDisconnect())
    ];
  }

  async #enable() {
    await this.cdp.attach();
    await this.cdp.send('Runtime.enable');
    this.#targetId = this.cdp.statusSnapshot().targetId;
  }

  #redact(text) {
    if (typeof text !== 'string') return text;
    const secrets = this.secrets() ?? [];
    return secrets.length === 0 ? text : redactSecrets(text, secrets);
  }

  #onConsole(params) {
    if (!this.#running) return;
    const rendered = cap(( params.args ?? []).map(renderArg).join(' '), ARGS_CAP);
    this.#buffer.push({
      kind: 'console',
      pageTs: params.timestamp ?? null,
      targetId: this.#targetId,
      level: params.type ?? 'log',
      args: this.#redact(rendered),
      stackTop: this.#redact(stackTop(params.stackTrace)),
      url: this.#redact(params.stackTrace?.callFrames?.[0]?.url ?? null)
    });
  }

  #onException(params) {
    if (!this.#running) return;
    const details = params.exceptionDetails ?? {};
    this.#buffer.push({
      kind: 'exception',
      pageTs: params.timestamp ?? null,
      targetId: this.#targetId,
      // Carried so that tail({ level: 'error' }) includes uncaught exceptions.
      // Filtering for errors and getting only console.error back would hide
      // the loudest evidence there is.
      level: 'error',
      text: this.#redact(details.text ?? null),
      description: this.#redact(details.exception?.description ?? null),
      stackTop: this.#redact(stackTop(details.stackTrace)),
      url: this.#redact(details.url ?? null)
    });
  }

  // Task 10 replaces this with the re-attach supervisor.
  #onDisconnect() {}

  tail({ cursor = 0, since = null, until = null, limit = 100, level = null, targetId = null, text = null } = {}) {
    if (!this.#running) {
      throw new Error(
        'The console tailer is not running, so there is nothing to tail. An empty result here ' +
          'would read as "the page logged nothing" when the truth is "nothing was listening". ' +
          'Call lol_cdp_console_start first.'
      );
    }
    const needle = text === null ? null : text.toLowerCase();
    // A reattach is context for whatever is being read, not noise: it survives
    // every filter except an explicit kinds selection.
    const predicate = (e) => {
      if (e.kind === 'reattach') return true;
      if (level !== null && e.level !== level) return false;
      if (targetId !== null && e.targetId !== targetId) return false;
      if (needle !== null) {
        const haystack = `${e.args ?? ''} ${e.text ?? ''} ${e.description ?? ''}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    };
    const page = this.#buffer.select({ cursor, since, until, limit, predicate });
    return {
      ...page,
      running: this.#running,
      attached: this.cdp.statusSnapshot().attached,
      targetId: this.#targetId,
      startedAt: this.#startedAt
    };
  }

  stop() {
    if (!this.#running) return { stopped: false, entries: this.#buffer?.length ?? 0 };
    this.#running = false;
    this.#reconnectOwner = null;
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe = [];
    this.cdp.close();
    return { stopped: true, entries: this.#buffer.length };
  }

  statusSnapshot() {
    return {
      running: this.#running,
      startedAt: this.#startedAt,
      targetId: this.#targetId,
      entries: this.#buffer?.length ?? 0,
      droppedTotal: this.#buffer?.droppedTotal ?? 0,
      lastError: this.#lastError
    };
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test tests/cdp-console.test.js`
Expected: PASS, 12 tests

- [x] **Step 5: Run the full suite**

Run: `npm test`
Expected: 187 passing, 0 failing

- [x] **Step 6: Commit**

```bash
git add src/cdp/console.js tests/cdp-console.test.js
git commit -m "feat: buffer CDP console output with ingest-time redaction"
```

---

### Task 10: Console tailer — re-attach supervisor

**Files:**
- Modify: `src/cdp/console.js`
- Test: `tests/cdp-console.test.js` (append)

**Interfaces:**
- Consumes: Task 9
- Produces: `reattach` entries; buffering continues across a renderer reload

**Why:** capturing what happened across a reload is the entire point. The target id changes when the renderer reloads, so without a supervisor the tailer goes deaf exactly when the interesting thing happens.

- [x] **Step 1: Write the failing test**

Append to `tests/cdp-console.test.js`:

```js
test('a disconnect re-attaches and records the reattach with both target ids', async () => {
  const { cdp, tailer } = harness();
  await tailer.start();
  cdp.emit('Runtime.consoleAPICalled', consoleEvent({ args: [{ type: 'string', value: 'before' }] }));

  cdp.target.id = 'PAGE-2'; // the renderer reloaded under us
  cdp.emitClose();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  cdp.emit('Runtime.consoleAPICalled', consoleEvent({ args: [{ type: 'string', value: 'after' }] }));

  const { entries } = tailer.tail({ limit: 100 });
  const reattach = entries.find((e) => e.kind === 'reattach');
  assert.ok(reattach, 'a reattach entry was recorded');
  assert.equal(reattach.previousTargetId, 'PAGE-1');
  assert.equal(reattach.targetId, 'PAGE-2');
  assert.ok(reattach.gapMs >= 0);

  const args = entries.filter((e) => e.kind === 'console').map((e) => e.args);
  assert.deepEqual(args, ['before', 'after'], 'buffering continued across the reload');
  tailer.stop();
});

test('Runtime.enable is re-issued on the new socket', async () => {
  const { cdp, tailer } = harness();
  await tailer.start();
  const before = cdp.sent.filter((s) => s.method === 'Runtime.enable').length;
  cdp.emitClose();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(cdp.sent.filter((s) => s.method === 'Runtime.enable').length, before + 1);
  tailer.stop();
});

test('a reattach survives a level filter that would exclude everything else', async () => {
  const { cdp, tailer } = harness();
  await tailer.start();
  cdp.emit('Runtime.consoleAPICalled', consoleEvent({ type: 'log' }));
  cdp.emitClose();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  const { entries } = tailer.tail({ level: 'error', limit: 100 });
  assert.ok(entries.some((e) => e.kind === 'reattach'), 'the reload is context, not noise');
  tailer.stop();
});

test('a failed re-attach retries and does not lose the tailer', async () => {
  const { cdp, tailer } = harness();
  await tailer.start();
  let failures = 0;
  const realAttach = cdp.attach;
  cdp.attach = async () => {
    failures += 1;
    if (failures === 1) throw new Error('CDP unavailable on port 8888');
    return realAttach.call(cdp);
  };
  cdp.emitClose();
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));

  assert.ok(failures >= 2, 'the supervisor retried');
  assert.equal(tailer.statusSnapshot().running, true);
  tailer.stop();
});

test('stop orphans an in-flight re-attach loop', async () => {
  const cdp = fakeCdp();
  let release;
  const tailer = new ConsoleTailer({
    cdp,
    config: { cdpConsoleBufferSize: 100 },
    clock: fakeClock(),
    delay: () => new Promise((r) => { release = r; })
  });
  await tailer.start();
  const before = cdp.sent.length;
  cdp.emitClose();
  await new Promise((r) => setImmediate(r));

  tailer.stop();
  release();
  await new Promise((r) => setImmediate(r));

  assert.equal(cdp.sent.length, before, 'nothing was sent after stop');
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/cdp-console.test.js`
Expected: FAIL — no `reattach` entry is recorded

- [x] **Step 3: Replace the `#onDisconnect` placeholder**

Add a private field `#lastDisconnectTs = null;` and replace `#onDisconnect`:

```js
  #onDisconnect() {
    if (!this.#running) return;
    this.#lastDisconnectTs = this.clock.now();
    // Fire and forget: no MCP call is waiting on this.
    this.#reattach();
  }

  // The renderer reloading changes the target id, which is exactly when the
  // interesting thing happens. Without this the tailer goes deaf at the worst
  // possible moment, and the empty buffer reads as "the page logged nothing".
  async #reattach() {
    if (this.#reconnectOwner !== null) return;
    const owner = Symbol('reattach');
    this.#reconnectOwner = owner;
    const previousTargetId = this.#targetId;
    const sinceTs = this.#lastDisconnectTs;
    try {
      for (let attempt = 0; this.#running && this.#reconnectOwner === owner; attempt += 1) {
        await this.delay(backoffDelay(attempt));
        if (!this.#running || this.#reconnectOwner !== owner) return;
        try {
          await this.#enable();
        } catch (err) {
          this.#lastError = this.#redact(err instanceof Error ? err.message : String(err));
          continue;
        }
        this.#buffer.push({
          kind: 'reattach',
          previousTargetId,
          targetId: this.#targetId,
          gapMs: sinceTs === null ? null : this.clock.now() - sinceTs
        });
        this.#lastError = null;
        return;
      }
    } finally {
      if (this.#reconnectOwner === owner) this.#reconnectOwner = null;
    }
  }
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test tests/cdp-console.test.js`
Expected: PASS, 17 tests

- [x] **Step 5: Run the full suite**

Run: `npm test`
Expected: 192 passing, 0 failing

- [x] **Step 6: Commit**

```bash
git add src/cdp/console.js tests/cdp-console.test.js
git commit -m "feat: re-attach the console tailer across renderer reloads"
```

---

### Task 11: Console tools and wiring

**Files:**
- Create: `src/tools/console.js`
- Modify: `src/index.js`
- Modify: `src/tools/status.js`
- Test: `tests/tools-console.test.js`
- Modify: `tests/tools-status.test.js`

**Interfaces:**
- Consumes: `ConsoleTailer` (Tasks 9-10)
- Produces: `registerConsoleTools(server, ctx)`; `ctx.consoleTailer`

**Note:** the tailer needs its **own** `CdpClient`, separate from `ctx.cdp`, so its reconnect supervisor cannot destabilise `lol_eval` / `lol_dom_query`.

- [x] **Step 1: Write the failing test**

```js
// tests/tools-console.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerConsoleTools } from '../src/tools/console.js';

function register(tailer) {
  const handlers = new Map();
  const server = { registerTool: (name, _meta, handler) => handlers.set(name, handler) };
  registerConsoleTools(server, { consoleTailer: tailer, secrets: () => [] });
  return handlers;
}

const parse = (result) => JSON.parse(result.content[0].text);

test('start reports the attached target', async () => {
  const handlers = register({ start: async () => ({ startedAt: 1, targetId: 'PAGE-1' }) });
  assert.equal(parse(await handlers.get('lol_cdp_console_start')({})).targetId, 'PAGE-1');
});

test('tail forwards every filter', async () => {
  const calls = [];
  const handlers = register({
    tail: (options) => {
      calls.push(options);
      return { entries: [], cursor: 0, dropped: 0, remaining: 0, running: true, attached: true, targetId: 'P', startedAt: 1 };
    }
  });
  await handlers.get('lol_cdp_console_tail')({
    since: 10, until: 20, cursor: 3, limit: 25, level: 'error', targetId: 'P', text: 'socket'
  });
  assert.deepEqual(calls[0], {
    since: 10, until: 20, cursor: 3, limit: 25, level: 'error', targetId: 'P', text: 'socket'
  });
});

test('tailing a stopped tailer is a tool error, not an empty success', async () => {
  const handlers = register({
    tail: () => {
      throw new Error('The console tailer is not running, so there is nothing to tail.');
    }
  });
  const result = await handlers.get('lol_cdp_console_tail')({});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not running/);
});

test('stop reports how many entries were held', async () => {
  const handlers = register({ stop: () => ({ stopped: true, entries: 9 }) });
  assert.equal(parse(await handlers.get('lol_cdp_console_stop')({})).entries, 9);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/tools-console.test.js`
Expected: FAIL — `Cannot find module '../src/tools/console.js'`

- [x] **Step 3: Write `src/tools/console.js`**

```js
import { z } from 'zod';
import { guard, ok } from './result.js';

export function registerConsoleTools(server, ctx) {
  server.registerTool(
    'lol_cdp_console_start',
    {
      title: 'Start tailing the client console',
      description:
        'Attach to the client renderer and begin buffering console output and uncaught ' +
        'exceptions in the background, re-attaching automatically when the renderer reloads and ' +
        'the target id changes. Call this BEFORE the thing you want to capture: the buffer only ' +
        'holds what arrived after it started.',
      inputSchema: {}
    },
    guard(async () => ok(await ctx.consoleTailer.start()), ctx)
  );

  server.registerTool(
    'lol_cdp_console_tail',
    {
      title: 'Read buffered client console output',
      description:
        'Return buffered console entries after your cursor. Times are epoch milliseconds: "ts" ' +
        'is this process\'s anchored clock, "pageTs" is the renderer\'s own stamp, and their ' +
        'difference is a delivery-latency signal. "reattach" entries mark renderer reloads and ' +
        'survive every filter, because a reload is context for whatever you are reading. Errors ' +
        'if the tailer is not running rather than returning an empty result.',
      inputSchema: {
        since: z.number().optional().describe('lower bound on ts, epoch milliseconds'),
        until: z.number().optional().describe('upper bound on ts, epoch milliseconds'),
        cursor: z.number().int().min(0).optional().describe('seq cursor from a previous tail'),
        limit: z.number().int().min(1).max(2000).optional().describe('max entries, default 100'),
        level: z.string().optional().describe('console severity, e.g. "error" or "warning"'),
        targetId: z.string().optional().describe('restrict to one renderer incarnation'),
        text: z.string().optional().describe('case-insensitive substring of the message')
      }
    },
    guard(
      async ({ since = null, until = null, cursor = 0, limit = 100, level = null, targetId = null, text = null }) =>
        ok(ctx.consoleTailer.tail({ since, until, cursor, limit, level, targetId, text })),
      ctx
    )
  );

  server.registerTool(
    'lol_cdp_console_stop',
    {
      title: 'Stop tailing the client console',
      description: 'Detach and close the tailer socket. Buffered entries are discarded with it.',
      inputSchema: {}
    },
    guard(async () => ok(ctx.consoleTailer.stop()), ctx)
  );
}
```

- [x] **Step 4: Wire into `src/index.js`**

Add imports:

```js
import { ConsoleTailer } from './cdp/console.js';
import { registerConsoleTools } from './tools/console.js';
```

In `buildContext`, after `const recorder = ...`:

```js
  // Its own CDP socket: the tailer's re-attach supervisor must not be able to
  // destabilise the shared client that lol_eval and lol_dom_query use.
  const consoleCdp = new CdpClient({ port: config.cdpPort });
  const consoleTailer = new ConsoleTailer({
    cdp: consoleCdp,
    config,
    secrets: () => (lcu.currentPassword() ? [lcu.currentPassword()] : [])
  });
```

Add `consoleTailer` to the returned object, and in `createServer` add:

```js
  registerConsoleTools(server, ctx);
```

- [x] **Step 5: Add tailer state to `src/tools/status.js`**

Add `console: ctx.consoleTailer.statusSnapshot(),` to the `ok({...})` object, after `recorder:`.

- [x] **Step 6: Update the exact-tool-set assertion**

In `tests/tools-status.test.js`, the list is alphabetical, so these three go at the **top**, before `lol_dom_query`:

```js
    'lol_cdp_console_start',
    'lol_cdp_console_stop',
    'lol_cdp_console_tail',
    'lol_dom_query',
```

Also add `console` to any `lol_status` key assertion.

- [x] **Step 7: Run the full suite**

Run: `npm test`
Expected: 196 passing, 0 failing

- [x] **Step 8: Commit**

```bash
git add src/tools/console.js src/index.js src/tools/status.js tests/tools-console.test.js tests/tools-status.test.js
git commit -m "feat: expose the CDP console tailer as MCP tools"
```

---

## Phase 3 — Durability (Task 12)

### Task 12: NDJSON sink

**Files:**
- Create: `src/lcu/ndjson.js`
- Modify: `src/lcu/recorder.js`
- Test: `tests/ndjson.test.js`
- Test: `tests/recorder.test.js` (append)

**Interfaces:**
- Consumes: nothing
- Produces: `class NdjsonSink`
  - `new NdjsonSink({ path, onError, createStream? })`
  - `write(entry) -> boolean` — false once disabled
  - `close()`
  - `get disabled`

**Why before `exceptionDetails`:** both a wrapped ring buffer and a restarted MCP process lose the evidence silently, which is the one outcome that wastes a whole game session.

- [x] **Step 1: Write the failing test**

```js
// tests/ndjson.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { NdjsonSink } from '../src/lcu/ndjson.js';

class FakeStream extends EventEmitter {
  written = [];
  ended = false;
  write(chunk) {
    this.written.push(chunk);
    return true;
  }
  end() {
    this.ended = true;
  }
}

function harness() {
  const stream = new FakeStream();
  const errors = [];
  const sink = new NdjsonSink({
    path: 'C:\\tmp\\rec.ndjson',
    onError: (message) => errors.push(message),
    createStream: () => stream
  });
  return { sink, stream, errors };
}

test('each entry is written as one JSON line', () => {
  const { sink, stream } = harness();
  sink.write({ kind: 'event', uri: '/a', seq: 1 });
  sink.write({ kind: 'close', code: 1006, seq: 2 });
  assert.equal(stream.written.length, 2);
  assert.equal(JSON.parse(stream.written[0]).uri, '/a');
  assert.ok(stream.written[0].endsWith('\n'));
  assert.equal(JSON.parse(stream.written[1]).code, 1006);
});

test('a stream error disables the sink and reports once', () => {
  const { sink, stream, errors } = harness();
  stream.emit('error', new Error('ENOSPC: no space left on device'));

  assert.equal(sink.disabled, true);
  assert.equal(sink.write({ kind: 'event' }), false);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /ENOSPC/);
});

test('a write that throws disables the sink rather than propagating', () => {
  const { sink, stream, errors } = harness();
  stream.write = () => {
    throw new Error('stream destroyed');
  };
  assert.doesNotThrow(() => sink.write({ kind: 'event' }));
  assert.equal(sink.disabled, true);
  assert.match(errors[0], /stream destroyed/);
});

test('close ends the stream and stops accepting writes', () => {
  const { sink, stream } = harness();
  sink.close();
  assert.equal(stream.ended, true);
  assert.equal(sink.write({ kind: 'event' }), false);
});
```

Append to `tests/recorder.test.js`:

```js
test('every timeline entry is mirrored to the sink when one is configured', async () => {
  const written = [];
  const h = harness();
  h.recorder.attachSink({ write: (entry) => { written.push(entry); return true; }, close() {}, disabled: false });

  const socket = await started(h);
  socket.emit('message', frame('/lol-gameflow/v1/gameflow-phase'));
  h.recorder.stop();

  const kinds = written.map((e) => e.kind);
  assert.ok(kinds.includes('start'));
  assert.ok(kinds.includes('open'));
  assert.ok(kinds.includes('event'));
  assert.ok(kinds.includes('stop'));
  assert.ok(written.every((e) => typeof e.seq === 'number' && typeof e.ts === 'number'));
});

test('a sink failure records an error entry and never stops the recording', async () => {
  const h = harness();
  h.recorder.attachSink({ write: () => false, close() {}, disabled: true });
  const socket = await started(h);
  socket.emit('message', frame('/a'));
  assert.equal(h.recorder.statusSnapshot().running, true, 'the recording continues');
  h.recorder.stop();
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `node --test tests/ndjson.test.js tests/recorder.test.js`
Expected: FAIL — `Cannot find module '../src/lcu/ndjson.js'`, `attachSink is not a function`

- [x] **Step 3: Write `src/lcu/ndjson.js`**

```js
import { createWriteStream } from 'node:fs';

// Both a wrapped ring buffer and a restarted MCP process lose the recording
// silently — the one outcome that wastes an entire game session. This is the
// escape hatch, off by default.
export class NdjsonSink {
  #stream = null;
  #disabled = false;

  constructor({ path, onError = () => {}, createStream = (p) => createWriteStream(p, { flags: 'a' }) }) {
    this.path = path;
    this.onError = onError;
    this.#stream = createStream(path);
    this.#stream.on('error', (err) => this.#disable(err?.message ?? String(err)));
  }

  get disabled() {
    return this.#disabled;
  }

  // A full disk must never terminate the recording: the in-memory timeline is
  // still evidence, and losing it because the file failed would be the worse
  // of the two outcomes.
  #disable(message) {
    if (this.#disabled) return;
    this.#disabled = true;
    this.onError(`recording file ${this.path} disabled: ${message}`);
  }

  write(entry) {
    if (this.#disabled || this.#stream === null) return false;
    try {
      this.#stream.write(`${JSON.stringify(entry)}\n`);
      return true;
    } catch (err) {
      this.#disable(err?.message ?? String(err));
      return false;
    }
  }

  close() {
    const stream = this.#stream;
    this.#stream = null;
    this.#disabled = true;
    try {
      stream?.end();
    } catch {
      // already gone
    }
  }
}
```

- [x] **Step 4: Route every push through the sink in `src/lcu/recorder.js`**

Add a private field `#sink = null;` and this method:

```js
  attachSink(sink) {
    this.#sink = sink;
  }
```

Add a single choke point and replace **every** `this.#buffer.push(...)` call in the class with `this.#push(...)`:

```js
  // One choke point so that no entry can reach the buffer without also
  // reaching the file, and vice versa.
  #push(entry) {
    const stored = this.#buffer.push(entry);
    this.#sink?.write(stored);
    return stored;
  }
```

`#ingest` already uses the return value for `#countUri`, so keep `const stored = this.#push({...})` there.

- [x] **Step 5: Wire the sink in `src/index.js`**

After constructing the recorder:

```js
  if (config.wampRecordFile) {
    recorder.attachSink(new NdjsonSink({ path: config.wampRecordFile }));
  }
```

with `import { NdjsonSink } from './lcu/ndjson.js';` at the top.

- [x] **Step 6: Run the full suite**

Run: `npm test`
Expected: 202 passing, 0 failing

- [x] **Step 7: Commit**

```bash
git add src/lcu/ndjson.js src/lcu/recorder.js src/index.js tests/ndjson.test.js tests/recorder.test.js
git commit -m "feat: optionally append the recorded timeline to an NDJSON file"
```

---

## Phase 4 — Structured exception details (Task 13)

### Task 13: `exceptionDetails` on `lol_eval`

**Files:**
- Modify: `src/cdp/client.js:98-113`
- Modify: `src/tools/dom.js`
- Test: `tests/cdp-client.test.js` (modify the existing exception test)
- Test: `tests/tools-dom.test.js` (modify)

**Interfaces:**
- Consumes: nothing
- Produces: `evaluate(expression, { awaitPromise }) -> { value, exceptionDetails }` where `exceptionDetails` is `null` on success

**Breaking change:** `evaluate()` no longer throws on a page exception. `domQuery` is the other caller and must throw itself to preserve its contract.

- [x] **Step 1: Update the two existing tests and add new ones**

In `tests/cdp-client.test.js`, replace the test `'evaluate returns the by-value result'` body assertion with:

```js
  assert.deepEqual(await client.evaluate('1 + 41'), { value: 42, exceptionDetails: null });
```

Replace the test `'evaluate surfaces a page exception as an error'` entirely with:

```js
test('evaluate returns a page exception as structured data, not a throw', async () => {
  const { client, sockets } = harness();
  await client.attach();
  sockets[0].responder = () => ({
    result: {
      exceptionDetails: {
        text: 'Uncaught',
        lineNumber: 3,
        columnNumber: 11,
        exception: { description: 'ReferenceError: nope is not defined' },
        stackTrace: { callFrames: [{ functionName: 'probe', url: 'p.js', lineNumber: 3, columnNumber: 11 }] }
      }
    }
  });
  const result = await client.evaluate('nope');
  assert.equal(result.value, undefined);
  assert.equal(result.exceptionDetails.description, 'ReferenceError: nope is not defined');
  assert.equal(result.exceptionDetails.lineNumber, 3);
  assert.deepEqual(result.exceptionDetails.stackTrace, [
    { functionName: 'probe', url: 'p.js', lineNumber: 3, columnNumber: 11 }
  ]);
  client.close();
});

test('domQuery still throws on a page exception', async () => {
  const { client, sockets } = harness();
  await client.attach();
  sockets[0].responder = () => ({
    result: { exceptionDetails: { exception: { description: 'SyntaxError: bad selector' } } }
  });
  await assert.rejects(client.domQuery('.x'), /SyntaxError: bad selector/);
  client.close();
});
```

In `tests/cdp-client.test.js`, the `'domQuery passes the selector as data, not code'` test already asserts on the returned nodes; it needs no change once `domQuery` unwraps `value` itself.

In `tests/tools-dom.test.js`, find the `lol_eval` success test and update the expected payload to include `exceptionDetails: null`. Add:

```js
test('lol_eval returns a page exception as data rather than a tool error', async () => {
  // Wire the same fake cdp this file already uses, with evaluate resolving to
  // an exceptionDetails payload.
  const ctx = {
    config: { allowEval: true, configPath: 'config/allowlist.json' },
    cdp: {
      evaluate: async () => ({
        value: undefined,
        exceptionDetails: { description: 'TypeError: socket is null', lineNumber: 12, stackTrace: [] }
      })
    },
    secrets: () => []
  };
  const handlers = new Map();
  registerDomTools({ registerTool: (name, _meta, handler) => handlers.set(name, handler) }, ctx);
  const result = await handlers.get('lol_eval')({ expression: 'probe.socket.readyState' });
  assert.notEqual(result.isError, true, 'a page exception is data, not a tool failure');
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.exceptionDetails.description, 'TypeError: socket is null');
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `node --test tests/cdp-client.test.js tests/tools-dom.test.js`
Expected: FAIL — `evaluate` still throws

- [x] **Step 3: Change `evaluate` in `src/cdp/client.js`**

```js
  // A page exception is data, not a failure: the whole point of evaluating a
  // probe is to learn what the page thinks, and "it threw, here is the stack"
  // is an answer. domQuery, whose contract is a value, throws on it instead.
  async evaluate(expression, { awaitPromise = false } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true
    });
    if (!result.exceptionDetails) return { value: result.result?.value, exceptionDetails: null };
    const details = result.exceptionDetails;
    return {
      value: result.result?.value,
      exceptionDetails: {
        text: details.text ?? null,
        description: details.exception?.description ?? null,
        lineNumber: details.lineNumber ?? null,
        columnNumber: details.columnNumber ?? null,
        stackTrace: (details.stackTrace?.callFrames ?? []).slice(0, 10).map((f) => ({
          functionName: f.functionName,
          url: f.url,
          lineNumber: f.lineNumber,
          columnNumber: f.columnNumber
        }))
      }
    };
  }
```

Change the last line of `domQuery` from `return this.evaluate(expression);` to:

```js
    const { value, exceptionDetails } = await this.evaluate(expression);
    if (exceptionDetails) {
      throw new Error(`Page threw: ${exceptionDetails.description ?? exceptionDetails.text ?? 'unknown page exception'}`);
    }
    return value;
```

and mark `domQuery` `async` if it is not already.

- [x] **Step 4: Update `lol_eval` in `src/tools/dom.js`**

Change the handler's return from `ok({ value: await ctx.cdp.evaluate(...) })` to:

```js
      const { value, exceptionDetails } = await ctx.cdp.evaluate(expression, { awaitPromise });
      return ok({ value, exceptionDetails });
```

- [x] **Step 5: Confirm the redaction path**

`guard()` only redacts thrown errors, so `exceptionDetails` — now a success payload — bypasses it. Add to the `lol_eval` handler, before returning:

```js
      const secrets = ctx.secrets?.() ?? [];
```

and redact the two free-text fields:

```js
      const safeDetails =
        exceptionDetails === null
          ? null
          : {
              ...exceptionDetails,
              text: redactSecrets(exceptionDetails.text, secrets),
              description: redactSecrets(exceptionDetails.description, secrets)
            };
      return ok({ value, exceptionDetails: safeDetails });
```

with `import { redactSecrets } from '../redact.js';` at the top of `src/tools/dom.js`.

Add this test to `tests/tools-dom.test.js`:

```js
test('a password in a page exception never reaches the tool result', async () => {
  const ctx = {
    config: { allowEval: true, configPath: 'config/allowlist.json' },
    cdp: {
      evaluate: async () => ({
        value: undefined,
        exceptionDetails: {
          text: 'failed on wss://riot:super-secret-pw@127.0.0.1:1/',
          description: 'Error: wss://riot:super-secret-pw@127.0.0.1:1/',
          lineNumber: 1,
          columnNumber: 1,
          stackTrace: []
        }
      })
    },
    secrets: () => ['super-secret-pw']
  };
  const handlers = new Map();
  registerDomTools({ registerTool: (name, _meta, handler) => handlers.set(name, handler) }, ctx);
  const result = await handlers.get('lol_eval')({ expression: 'x' });
  assert.ok(!result.content[0].text.includes('super-secret-pw'));
});
```

- [x] **Step 6: Run the full suite**

Run: `npm test`
Expected: 206 passing, 0 failing

- [x] **Step 7: Commit**

```bash
git add src/cdp/client.js src/tools/dom.js tests/cdp-client.test.js tests/tools-dom.test.js
git commit -m "feat: return page exception details as data from lol_eval"
```

---

### Task 14: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/design.md`

- [x] **Step 1: Add the six new tools to the README tool table**

After the existing `lol_eval` row:

```markdown
| `lol_wamp_record_start(uris?, restart?)` | Record LCU WAMP traffic on an independent socket |
| `lol_wamp_record_dump(uri?, since?, until?, kinds?, limit?, cursor?)` | Dump the recorded timeline and per-URI stats |
| `lol_wamp_record_stop()` | Close the recorder socket |
| `lol_cdp_console_start()` | Begin buffering client console output |
| `lol_cdp_console_tail(since?, until?, cursor?, limit?, level?, targetId?, text?)` | Read buffered console entries |
| `lol_cdp_console_stop()` | Stop and discard the console buffer |
```

- [x] **Step 2: Add the six config keys to the README configuration table**

```markdown
| `wampRecordBufferSize` | `20000` | Recorder timeline entry count |
| `wampRecordMaxBytes` | `67108864` | Recorder byte budget; evicts on whichever fills first |
| `wampRecordPayloadCap` | `512` | Per-payload truncation for the recorder |
| `wampRecordFullPayloadUris` | `["/lol-gameflow/v1/gameflow-phase"]` | URI prefixes exempt from the payload cap |
| `wampRecordFile` | `null` | Optional NDJSON path the timeline is appended to |
| `cdpConsoleBufferSize` | `5000` | Console tailer entry count |
```

- [x] **Step 3: Add a short usage note to the README**

```markdown
**Diagnosing a missing event.** `lol_wamp_record_*` runs on its own WAMP socket
outside the client renderer, so it proves what the LCU actually emitted and
when. Read it together with `lol_cdp_console_tail` and a `lol_eval` probe to
separate three cases: the LCU never emitted, it emitted but the page never
received, or the page received and mishandled. Start both recorders *before*
the thing you want to observe — they only hold what arrived after they started.
```

- [x] **Step 4: Add a paragraph to `docs/design.md` under `## Events`**

Point at the spec rather than repeating it:

```markdown
The event tap above is a live watch. For forensic work there is a second,
independent recorder on its own WAMP socket — see
`docs/superpowers/specs/2026-09-07-lcu-forensics-design.md`. It is deliberately
separate: the recorder's only value is that nothing else can perturb it.
```

- [x] **Step 5: Run the full suite one last time**

Run: `npm test`
Expected: 206 passing, 0 failing

- [x] **Step 6: Commit**

```bash
git add README.md docs/design.md
git commit -m "docs: document the recorder and console tailer tools"
```

---

## Verification checklist

Run before declaring the work complete:

- [ ] `npm test` — 206 passing, 0 failing
- [ ] `git log --oneline c0663c0..HEAD -- tests/ingest.test.js` prints nothing (the tap's regression check was never edited)
- [ ] `git log --oneline c0663c0..HEAD -- tests/events-tap.test.js` prints nothing (the `backoffDelay` re-export did not disturb it)
- [ ] `git log --oneline` shows one commit per task, none carrying an AI attribution trailer
- [ ] `grep -rn "recvTs" src/` returns nothing (the field was renamed to the `ts`/`wallTs`/`pageTs` triple)
- [ ] Manual smoke with the client running: `lol_wamp_record_start()`, change screens, `lol_wamp_record_dump({ uri: "/lol-gameflow/" })` shows gameflow events plus `start`/`open` entries with epoch-comparable `ts`
- [ ] Manual smoke: `lol_cdp_console_start()`, reload the renderer via Pengu, `lol_cdp_console_tail()` shows a `reattach` entry and keeps logging afterwards
- [ ] Manual smoke: `lol_cdp_console_tail()` before start returns a tool error, not an empty success
