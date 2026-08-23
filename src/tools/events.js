import { z } from 'zod';
import { guard, ok } from './result.js';

export function registerEventTools(server, ctx) {
  server.registerTool(
    'lol_events_start',
    {
      title: 'Start buffering LCU events',
      description:
        'Open the OnJsonApiEvent tap and buffer events in memory. Filters are URI prefixes applied ' +
        'at ingest, e.g. "/lol-champ-select/" — the unfiltered firehose fills the buffer in seconds, ' +
        'so pass filters unless you truly want everything. Calling this while already running ' +
        'replaces the filters and keeps buffered entries.',
      inputSchema: {
        filters: z
          .array(z.string().startsWith('/'))
          .optional()
          .describe('URI prefixes, e.g. ["/lol-champ-select/", "/lol-gameflow/"]')
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
        'Return buffered events with seq greater than "since", plus the new cursor. A non-zero ' +
        '"dropped" means the buffer wrapped and that many events were lost after your cursor. ' +
        'Entries with truncated: true had their data clipped at 4 KB — re-fetch the full body with ' +
        'lol_get on the entry uri.',
      inputSchema: {
        since: z.number().int().min(0).optional().describe('cursor from the previous poll; omit to start at 0'),
        limit: z.number().int().min(1).max(500).optional().describe('max entries to return, default 100'),
        filter: z.string().optional().describe('extra URI prefix applied at poll time')
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
      description: 'Close the event tap. Buffered entries stay readable with lol_events_poll.',
      inputSchema: {}
    },
    guard(async () => {
      ctx.tap.stop();
      return ok({ stopped: true, buffered: ctx.buffer.length });
    }, ctx)
  );
}
