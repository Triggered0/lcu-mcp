import { z } from 'zod';
import { guard, ok } from './result.js';

export function registerEventTools(server, ctx) {
  server.registerTool(
    'lol_events_start',
    {
      title: 'Start buffering LCU events',
      description:
        'Open the League Client WebSocket event tap and buffer live OnJsonApiEvent Create/Update/Delete notifications in memory. ' +
        'Use this tool to monitor real-time client state changes (such as champ select progress, gameflow phase, or lobby party updates). ' +
        'To poll buffered events, call lol_events_poll. To record raw WAMP frames with socket lifecycle diagnostics, use lol_wamp_record_start instead. ' +
        'For static game assets, use lol_static instead. ' +
        'Behavior: Ring buffer evicts oldest events after buffer limit is reached. Calling while running updates URI filters and preserves already buffered events. ' +
        'Prerequisite: League client must be running.',
      inputSchema: {
        filters: z
          .array(z.string().startsWith('/'))
          .optional()
          .describe('Array of URI prefix filters applied at ingest (e.g. ["/lol-champ-select/", "/lol-gameflow/"]); omit for unfiltered firehose')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    guard(async ({ filters = [] }) => {
      await ctx.tap.start(filters);
      return ok({
        started: true,
        filters,
        note:
          filters.length === 0
            ? `No filters: every Create/Update/Delete is buffered and the oldest are evicted after ${ctx.config.eventBufferSize} entries.`
            : 'Filters apply only to events arriving from now on.'
      });
    }, ctx)
  );

  server.registerTool(
    'lol_events_poll',
    {
      title: 'Drain buffered LCU events',
      description:
        'Drain buffered League Client WebSocket events recorded since a given sequence cursor, returning events and the new cursor. ' +
        'Use this tool to incrementally consume live client events after calling lol_events_start. ' +
        'For recording full WAMP traffic frames, use lol_wamp_record_dump instead. ' +
        'If an event payload indicates truncated: true, use lol_get on the entry URI to fetch the full resource. ' +
        'Behavior: Safe and read-only. A non-zero dropped count indicates buffer overflow between polls.',
      inputSchema: {
        since: z.number().int().min(0).optional().describe('Monotonic sequence cursor from the previous poll call; omit or set to 0 to read from start of buffer'),
        limit: z.number().int().min(1).max(500).optional().describe('Maximum number of event entries to return (1-500, default: 100)'),
        filter: z.string().optional().describe('Optional case-insensitive URI prefix substring applied as a post-filter at poll time')
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    guard(async ({ since = 0, limit = 100, filter = null }) => {
      const page = ctx.buffer.since(since, limit, filter);
      return ok({ ...page, running: ctx.tap.statusSnapshot().running });
    }, ctx)
  );

  server.registerTool(
    'lol_events_stop',
    {
      title: 'Stop buffering LCU events',
      description:
        'Close the League Client WebSocket event tap and stop buffering live events. ' +
        'Use this tool to pause or end event collection and conserve memory. ' +
        'Buffered events remain readable via lol_events_poll after stopping. ' +
        'For stopping WAMP recording, use lol_wamp_record_stop instead. ' +
        'Behavior: Idempotent; safe to call when already stopped.',
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    guard(async () => {
      ctx.tap.stop();
      return ok({ stopped: true, buffered: ctx.buffer.length });
    }, ctx)
  );
}
