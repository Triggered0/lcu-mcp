import { z } from 'zod';
import { guard, ok } from './result.js';

export function registerLogTools(server, ctx) {
  server.registerTool(
    'lol_logs_tail',
    {
      title: 'Read recent log lines from disk',
      description:
        'Read the last N lines from the active or selected League Client, UX, or Game engine disk log. ' +
        'Redacts sensitive tokens and passwords before returning.',
      inputSchema: {
        target: z
          .enum(['client', 'ux', 'game'])
          .default('client')
          .describe('Log target: "client" (LCU core), "ux" (CEF UI), or "game" (r3dlog)'),
        lines: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .default(100)
          .describe('Number of lines to return from EOF (1-2000, default 100)'),
        level: z
          .enum(['ALWAYS', 'OKAY', 'INFO', 'WARN', 'ERROR', 'ALL'])
          .default('ALL')
          .describe('Filter by log level or ALL (default ALL)'),
        search: z.string().optional().describe('Case-insensitive substring filter applied to raw log line'),
        session: z.string().optional().describe('Session ID or log filename from lol_logs_sessions')
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    guard(
      async ({ target = 'client', lines = 100, level = 'ALL', search = null, session = null } = {}) =>
        ok(await ctx.logReader.tail({ target, lines, level, search, session })),
      ctx
    )
  );

  server.registerTool(
    'lol_logs_watch_start',
    {
      title: 'Start live disk log watcher',
      description:
        'Begin streaming newly appended log lines from the active log file into a ring buffer for polling.',
      inputSchema: {
        target: z
          .enum(['client', 'ux', 'game'])
          .default('client')
          .describe('Log target: "client", "ux", or "game"')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    guard(async ({ target = 'client' } = {}) => ok(await ctx.logWatcher.start({ target })), ctx)
  );

  server.registerTool(
    'lol_logs_watch_poll',
    {
      title: 'Poll buffered disk log entries',
      description:
        'Retrieve buffered log entries since the given cursor from the active log watcher.',
      inputSchema: {
        cursor: z.number().int().min(0).optional().describe('Sequence cursor from a previous poll'),
        limit: z.number().int().min(1).max(2000).optional().describe('Maximum entries to return (default 100)'),
        level: z.string().optional().describe('Filter by log level (e.g. "ERROR", "WARN", "ALL")'),
        search: z.string().optional().describe('Case-insensitive substring filter applied to log entries')
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    guard(
      async ({ cursor = 0, limit = 100, level = null, search = null } = {}) =>
        ok(ctx.logWatcher.poll({ cursor, limit, level, search })),
      ctx
    )
  );

  server.registerTool(
    'lol_logs_watch_stop',
    {
      title: 'Stop live disk log watcher',
      description:
        'Stop the active disk log watcher and discard its in-memory buffer.',
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    guard(async () => ok(await ctx.logWatcher.stop()), ctx)
  );

  server.registerTool(
    'lol_logs_sessions',
    {
      title: 'List log sessions on disk',
      description:
        'List available historical and active log files/sessions on disk sorted newest first.',
      inputSchema: {
        target: z
          .enum(['client', 'ux', 'game'])
          .default('client')
          .describe('Log target: "client", "ux", or "game"'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe('Maximum sessions to list (1-50, default 10)')
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    guard(
      async ({ target = 'client', limit = 10 } = {}) =>
        ok(await ctx.logFinder.findSessions(target, limit)),
      ctx
    )
  );
}
