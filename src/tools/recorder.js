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
        'Open a dedicated secondary WAMP WebSocket connection to the League Client and record raw frames alongside socket lifecycle events into a chronological timeline. ' +
        'Use this tool for deep protocol diagnostics, debugging connection drops, or analyzing WAMP message flows. ' +
        'For lightweight high-level event polling, prefer lol_events_start instead. ' +
        'To dump recorded frames, call lol_wamp_record_dump. ' +
        'Behavior: Captures open, close (with exit codes), errors, reconnect gaps, and message frames. Starting while already recording throws an error unless restart is true.',
      inputSchema: {
        uris: z
          .array(z.string().startsWith('/'))
          .optional()
          .describe('Optional array of specific URI paths to subscribe to (e.g. ["/lol-gameflow/v1/gameflow-phase"]); defaults to the full firehose'),
        restart: z.boolean().optional().describe('Whether to discard an active recording session and immediately begin a fresh timeline (default: false)')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    guard(async ({ uris = [], restart = false }) => ok(await ctx.recorder.start({ uris, restart })), ctx)
  );

  server.registerTool(
    'lol_wamp_record_dump',
    {
      title: 'Dump the recorded WAMP timeline',
      description:
        'Retrieve recorded WAMP timeline entries, socket lifecycle events, and cumulative per-URI statistics from the recorder buffer. ' +
        'Use this tool to inspect recorded WebSocket frames and diagnose whether a quiet URI received no traffic or the socket disconnected. ' +
        'Prerequisite: lol_wamp_record_start must have been called. For general timeline correlation across multiple subsystems, use lol_forensics_correlate. ' +
        'Behavior: Returns timestamped entries, dropped frame count, and cumulative per-URI stats surviving eviction.',
      inputSchema: {
        uri: z.string().optional().describe('Filter event entries by URI prefix; lifecycle events survive this filter'),
        since: z.number().optional().describe('Lower timestamp bound in epoch milliseconds'),
        until: z.number().optional().describe('Upper timestamp bound in epoch milliseconds'),
        kinds: z.array(z.enum(KINDS)).optional().describe('Filter entries strictly to specified event kinds (e.g. ["event", "open", "close", "error", "reconnect"])'),
        limit: z.number().int().min(1).max(2000).optional().describe('Maximum entries to return (1-2000, default: 100)'),
        cursor: z.number().int().min(0).optional().describe('Sequence cursor from a previous dump call for incremental pagination')
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
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
      description:
        'Terminate the dedicated WAMP recorder WebSocket connection and halt traffic capture. ' +
        'Use this tool when WAMP diagnostic recording is finished. Recorded entries remain accessible via lol_wamp_record_dump. ' +
        'Behavior: Idempotent; safe to call when already stopped.',
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    guard(async () => ok(ctx.recorder.stop('tool')), ctx)
  );
}
