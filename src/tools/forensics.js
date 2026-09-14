import { z } from 'zod';
import { correlateTimelines } from '../forensics/correlate.js';
import { createForensicsBundle } from '../forensics/bundle.js';
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
        sources: z
          .array(z.enum(['wamp', 'cdp', 'network', 'logs', 'game']))
          .optional()
          .describe('Filter telemetry streams to correlate'),
        uriPrefix: z.string().optional().describe('Filter WAMP events by URI prefix (e.g. /lol-gameflow/)'),
        levels: z
          .array(z.enum(['error', 'warning', 'info', 'log', 'debug']))
          .optional()
          .describe('Filter CDP console entries by level'),
        networkFailedOnly: z.boolean().optional().describe('Filter CDP network requests to failed only'),
        logLevel: z.string().optional().describe('Filter disk log entries by level'),
        format: z.enum(['narrative', 'events', 'summary']).default('narrative').describe('Output format')
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    guard(
      async ({
        since,
        until,
        limit = 100,
        sources,
        uriPrefix,
        levels,
        networkFailedOnly,
        logLevel,
        format = 'narrative'
      } = {}) => {
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

        let networkEntries = [];
        if (ctx?.networkTailer?.tail) {
          try {
            const tailed = ctx.networkTailer.tail({ since, until, failedOnly: networkFailedOnly, limit });
            networkEntries = tailed?.entries ?? [];
          } catch {
            networkEntries = [];
          }
        }

        let logEntries = [];
        if (ctx?.logWatcher?.poll) {
          try {
            const polled = ctx.logWatcher.poll({ limit, level: logLevel });
            logEntries = polled?.entries ?? [];
          } catch {
            logEntries = [];
          }
        }

        const result = correlateTimelines({
          wampEntries,
          cdpEntries,
          networkEntries,
          logEntries,
          limit,
          sources,
          levels,
          format
        });

        return ok(result);
      },
      ctx
    )
  );

  server.registerTool(
    'lol_forensics_bundle',
    {
      title: 'Generate comprehensive diagnostics bundle across all LCU telemetry streams',
      description:
        'Collects system status, active timeline streams (WAMP, CDP console, CDP network, disk logs, live game), ' +
        'and recent disk log tail into a unified Markdown report or structured JSON.',
      inputSchema: {
        since: z.number().optional().describe('Lower timestamp bound in epoch ms or clock ts'),
        until: z.number().optional().describe('Upper timestamp bound in epoch ms or clock ts'),
        limit: z.number().int().min(1).max(2000).default(200).describe('Maximum total events to include in timeline'),
        sources: z
          .array(z.enum(['wamp', 'cdp', 'network', 'logs', 'game']))
          .optional()
          .describe('Filter streams to include'),
        includeLogTail: z
          .boolean()
          .default(true)
          .describe('Include recent disk log tail if log watcher has no entries'),
        format: z.enum(['markdown', 'json']).default('markdown').describe('Output format')
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    guard(
      async ({
        since,
        until,
        limit = 200,
        sources,
        includeLogTail = true,
        format = 'markdown'
      } = {}) => {
        const result = await createForensicsBundle(ctx, {
          since,
          until,
          limit,
          sources,
          includeLogTail,
          format
        });
        return ok(result);
      },
      ctx
    )
  );
}
