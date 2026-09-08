# Phase 4: Unified Forensics Correlator (`lol_forensics_correlate`)

## Goal

Provide a unified cross-subsystem chronological correlation tool (`lol_forensics_correlate`) combining WAMP Recorder logs (`lol_wamp_record_dump`) and CDP Console Tailer logs (`lol_cdp_console_tail`) on a shared timestamp axis.

This answers the core diagnostic question in a single token-efficient view:
*"Did LCU send the event, did the renderer page receive it, and where did it break?"*

## Architecture

```
         ┌─────────────────────────┐     ┌─────────────────────────┐
         │      WAMP Recorder      │     │    CDP Console Tailer   │
         │     (LCU wire stream)   │     │    (CEF page logs)      │
         └────────────┬────────────┘     └────────────┬────────────┘
                      │                               │
                      │  { ts, wallTs, kind, ... }    │
                      ▼                               ▼
               ┌─────────────────────────────────────────────┐
               │         Forensics Correlator Core           │
               │   - Timestamp normalizer & merger (O(N+M))  │
               │   - Filtering (since, until, uri, level)    │
               │   - Token-optimized narrative formatter     │
               └──────────────────────┬──────────────────────┘
                                      │
                                      ▼
                           ┌─────────────────────┐
                           │lol_forensics_correlate│
                           │  (Narrative / JSON) │
                           └─────────────────────┘
```

## Locked Decisions

| Decision | Rationale |
|---|---|
| Use `ts` (monotonic hrtime anchored) as primary sort key | Both WAMP recorder and console tailer use `createClock()` timestamps anchored to the same epoch. Monotonic time avoids NTP clock step inversions. |
| Fallback to `wallTs` for human-readable ISO time | Format narrative lines with local/ISO time `HH:MM:SS.mmm` from `wallTs` while maintaining strict order via `ts`. |
| Token-optimized narrative format as default | Dumping raw JSON dumps from two buffers costs thousands of tokens. A compact narrative string (`[HH:MM:SS.mmm] [SRC:kind] text`) delivers the complete causal chain in <500 tokens. |
| Safe live read without consuming cursors | Read entries via `since` / `until` filters without mutating callers' individual dump cursors. |

## Tool Specification: `lol_forensics_correlate`

- **Input Schema**:
  ```ts
  {
    since: z.number().optional().describe('Lower timestamp bound in epoch ms or clock ts'),
    until: z.number().optional().describe('Upper timestamp bound in epoch ms or clock ts'),
    limit: z.number().int().min(1).max(1000).default(100).describe('Maximum total events to return'),
    uriPrefix: z.string().optional().describe('Filter WAMP events by URI prefix (e.g. /lol-gameflow/)'),
    levels: z.array(z.enum(['error', 'warning', 'info', 'log', 'debug'])).optional().describe('Filter CDP console entries by level'),
    format: z.enum(['narrative', 'events', 'summary']).default('narrative').describe('Output format: compact narrative log, structured events JSON, or high-level summary')
  }
  ```
- **Narrative Format**:
  ```text
  === LCU & CDP CORRELATED TIMELINE (14 events, 2 errors) ===
  [18:14:02.100] [WAMP:event] /lol-gameflow/v1/gameflow-phase -> "ChampSelect"
  [18:14:02.105] [CDP:error] TypeError: Cannot read properties of undefined at onGameflowChange (plugin.js:42)
  [18:14:02.150] [WAMP:event] /lol-champ-select/v1/session -> {"myTeam": [...]}
  ```
