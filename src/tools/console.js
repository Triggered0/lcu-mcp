import { z } from 'zod';
import { guard, ok } from './result.js';

export function registerConsoleTools(server, ctx) {
  server.registerTool(
    'lol_cdp_console_start',
    {
      title: 'Start tailing the client console',
      description:
        'Attach to the League Client renderer via Chrome DevTools Protocol (CDP) and begin streaming console logs, warnings, and uncaught exceptions into an in-memory buffer. ' +
        'Use this tool before executing UI actions or testing plugins to capture runtime frontend diagnostics. ' +
        'To retrieve buffered entries, call lol_cdp_console_tail. To stop capturing and release memory, call lol_cdp_console_stop. ' +
        'For client log files on disk, use lol_logs_tail instead. ' +
        'Behavior: Non-destructive; automatically survives renderer page reloads with continuity. Prerequisite: Active CDP connection.',
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    guard(async () => ok(await ctx.consoleTailer.start()), ctx)
  );

  server.registerTool(
    'lol_cdp_console_tail',
    {
      title: 'Read buffered client console output',
      description:
        'Retrieve buffered console logs, warnings, and runtime JavaScript exceptions recorded since the tailer was started or past a given cursor. ' +
        'Use this tool to inspect frontend errors, check component mounting logs, or debug UI scripts. ' +
        'Prerequisite: Must call lol_cdp_console_start first; fails if tailer is not running. ' +
        'For HTTP request traffic, use lol_cdp_network_tail instead. ' +
        'Behavior: Sequential integer cursors ensure gap-free incremental reading without skipping entries.',
      inputSchema: {
        since: z.number().optional().describe('Lower timestamp bound in epoch milliseconds; excludes older entries'),
        until: z.number().optional().describe('Upper timestamp bound in epoch milliseconds; excludes newer entries'),
        cursor: z.number().int().min(0).optional().describe('Sequence cursor from a previous tail call for incremental polling'),
        limit: z.number().int().min(1).max(2000).optional().describe('Maximum number of entries to return (1-2000, default: 100)'),
        level: z.string().optional().describe('Filter by console severity level, e.g. "error", "warning", "info", or "log"'),
        targetId: z.string().optional().describe('Filter entries to a specific CDP renderer target ID'),
        text: z.string().optional().describe('Case-insensitive substring filter matching log message text')
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
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
      description:
        'Detach from the League Client renderer and terminate the console log buffering session. ' +
        'Use this tool when console log capture is complete to release memory and close the CDP socket. ' +
        'For stopping network request capture, use lol_cdp_network_stop instead. ' +
        'Behavior: Discards any remaining unread entries from the in-memory buffer. Idempotent; safe to call when already stopped.',
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    guard(async () => ok(ctx.consoleTailer.stop()), ctx)
  );
}
