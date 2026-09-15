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
        'Correlate events across LCU WAMP, Chrome DevTools Protocol console logs, network requests, disk logs, and live game telemetry into a unified chronological timeline. ' +
        'Use this tool during incident triage to identify whether client state changes triggered frontend UI errors or network failures. ' +
        'For a complete system report with status snapshots, use lol_forensics_bundle instead. ' +
        'For raw console logs alone, use lol_cdp_console_tail. ' +
        'Behavior: Safe and read-only. Gracefully combines active in-memory streams without interrupting background loggers.',
      inputSchema: {
        since: z.number().optional().describe('Lower timestamp bound in epoch milliseconds or clock timestamp'),
        until: z.number().optional().describe('Upper timestamp bound in epoch milliseconds or clock timestamp'),
        limit: z.number().int().min(1).max(1000).default(100).describe('Maximum total events to return across all streams (1-1000, default: 100)'),
        sources: z
          .array(z.enum(['wamp', 'cdp', 'network', 'logs', 'game']))
          .optional()
          .describe('Array of telemetry stream sources to include: "wamp", "cdp", "network", "logs", "game"'),
        uriPrefix: z.string().optional().describe('Filter WAMP events by URI prefix (e.g. "/lol-gameflow/")'),
        levels: z
          .array(z.enum(['error', 'warning', 'info', 'log', 'debug']))
          .optional()
          .describe('Filter CDP console log entries by severity levels: "error", "warning", "info", "log", "debug"'),
        networkFailedOnly: z.boolean().optional().describe('If true, restricts CDP network requests strictly to transport/protocol failures'),
        logLevel: z.string().optional().describe('Filter disk log entries by log level string'),
        format: z.enum(['narrative', 'events', 'summary']).default('narrative').describe('Output format: "narrative" (Markdown), "events" (JSON array), or "summary"')
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
        'Generate an all-in-one diagnostic bundle combining system connectivity status, correlated telemetry timelines, and recent disk log tails. ' +
        'Use this tool as a single-call comprehensive health check or bug report export when diagnosing complex client issues. ' +
        'For interactive querying of specific streams, use lol_forensics_correlate or subsystem-specific tools. ' +
        'Behavior: Safe and read-only. Returns Markdown report by default, or structured JSON when specified.',
      inputSchema: {
        since: z.number().optional().describe('Lower timestamp bound in epoch milliseconds or clock timestamp'),
        until: z.number().optional().describe('Upper timestamp bound in epoch milliseconds or clock timestamp'),
        limit: z.number().int().min(1).max(2000).default(200).describe('Maximum total events to include in the combined timeline (1-2000, default: 200)'),
        sources: z
          .array(z.enum(['wamp', 'cdp', 'network', 'logs', 'game']))
          .optional()
          .describe('Array of telemetry stream sources to include in the bundle: "wamp", "cdp", "network", "logs", "game"'),
        includeLogTail: z
          .boolean()
          .default(true)
          .describe('Whether to append recent disk log tail if active log watcher has no fresh entries (default: true)'),
        format: z.enum(['markdown', 'json']).default('markdown').describe('Bundle output format: "markdown" for formatted text report, or "json" for structured object')
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
