import { z } from 'zod';
import { correlateTimelines } from '../forensics/correlate.js';
import { guard, ok } from './result.js';

export function registerForensicsTools(server, ctx) {
  server.registerTool(
    'lol_forensics_correlate',
    {
      title: 'Correlate LCU WAMP and CDP console timelines',
      description:
        'Combines WAMP recorder events and CDP console entries into a chronological timeline, ' +
        'answering whether the client emitted an event and where the frontend broke.',
      inputSchema: {
        since: z.number().optional().describe('Lower timestamp bound in epoch ms or clock ts'),
        until: z.number().optional().describe('Upper timestamp bound in epoch ms or clock ts'),
        limit: z.number().int().min(1).max(1000).default(100).describe('Maximum total events to return'),
        uriPrefix: z.string().optional().describe('Filter WAMP events by URI prefix (e.g. /lol-gameflow/)'),
        levels: z
          .array(z.enum(['error', 'warning', 'info', 'log', 'debug']))
          .optional()
          .describe('Filter CDP console entries by level'),
        format: z.enum(['narrative', 'events', 'summary']).default('narrative').describe('Output format')
      }
    },
    guard(
      async ({ since, until, limit = 100, uriPrefix, levels, format = 'narrative' } = {}) => {
        let wampEntries = [];
        if (ctx?.recorder?.dump) {
          try {
            const dumped = ctx.recorder.dump({ since, until, uri: uriPrefix, limit });
            wampEntries = dumped?.entries ?? [];
          } catch {
            wampEntries = [];
          }
        }

        let cdpEntries = [];
        if (ctx?.consoleTailer?.tail) {
          try {
            const tailed = ctx.consoleTailer.tail({ since, until, levels, limit });
            cdpEntries = tailed?.entries ?? [];
          } catch {
            cdpEntries = [];
          }
        }

        const result = correlateTimelines({
          wampEntries,
          cdpEntries,
          limit,
          format
        });

        return ok(result);
      },
      ctx
    )
  );
}
