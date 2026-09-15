import { z } from 'zod';
import { guard, ok } from './result.js';

export function registerLogTools(server, ctx) {
  server.registerTool(
    'lol_logs_tail',
    {
      title: 'Read recent log lines from disk',
      description:
        'Read the most recent log lines from the active or selected League Client, CEF UX, or Game engine disk log file. ' +
        'Use this tool to inspect historical or startup errors recorded on disk. ' +
        'For live streaming log monitoring, use lol_logs_watch_start and lol_logs_watch_poll instead. ' +
        'For in-memory renderer console messages, use lol_cdp_console_tail. ' +
        'Behavior: Safe and read-only. Automatically redacts passwords, auth tokens, and sensitive keys from log output.',
      inputSchema: {
        target: z
          .enum(['client', 'ux', 'game'])
          .default('client')
          .describe('Log target: "client" (LCU core), "ux" (CEF UI frontend), or "game" (r3dlog engine)'),
        lines: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .default(100)
          .describe('Number of lines to read backward from EOF (1-2000, default: 100)'),
        level: z
          .enum(['ALWAYS', 'OKAY', 'INFO', 'WARN', 'ERROR', 'ALL'])
          .default('ALL')
          .describe('Filter lines by log level or ALL (default: ALL)'),
        search: z.string().optional().describe('Case-insensitive substring filter applied to raw log lines'),
        session: z.string().optional().describe('Session ID or log filename from lol_logs_sessions; omit for active session')
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
        'Start watching a League Client disk log file for newly appended lines, streaming entries into an in-memory ring buffer. ' +
        'Use this tool before reproducing an issue to capture new disk log entries as they are written. ' +
        'To poll new entries, call lol_logs_watch_poll. When finished, call lol_logs_watch_stop. ' +
        'For one-off historical reads from disk, use lol_logs_tail instead. ' +
        'Behavior: Non-destructive. Ring buffer evicts oldest lines on overflow.',
      inputSchema: {
        target: z
          .enum(['client', 'ux', 'game'])
          .default('client')
          .describe('Log target subsystem to watch: "client" (LCU core), "ux" (CEF UI), or "game" (r3dlog engine)')
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
        'Poll newly buffered disk log entries captured by the active disk log watcher since a given cursor. ' +
        'Use this tool to consume real-time log lines while watching is active. ' +
        'Prerequisite: Requires lol_logs_watch_start to be running; returns empty if stopped. ' +
        'For reading historical lines from file EOF, use lol_logs_tail instead. ' +
        'Behavior: Safe and read-only. Supports cursor-based incremental polling without duplicates.',
      inputSchema: {
        cursor: z.number().int().min(0).optional().describe('Sequence cursor from a previous poll call for incremental reading'),
        limit: z.number().int().min(1).max(2000).optional().describe('Maximum entries to return (1-2000, default: 100)'),
        level: z
          .enum(['ALWAYS', 'OKAY', 'INFO', 'WARN', 'ERROR', 'ALL'])
          .optional()
          .describe('Filter entries by log level: "ALWAYS", "OKAY", "INFO", "WARN", "ERROR", or "ALL"'),
        search: z.string().optional().describe('Case-insensitive substring filter applied to log entry text')
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
        'Stop the active disk log watcher and release file handles and in-memory log buffer. ' +
        'Use this tool to end log watching and free memory when debugging is complete. ' +
        'Behavior: Idempotent; safe to call when already stopped.',
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
        'List historical and active League Client, UX, or Game log files on disk sorted by modification time, newest first. ' +
        'Use this tool to discover session identifiers or log filenames to pass into lol_logs_tail session parameter. ' +
        'For reading log content directly, use lol_logs_tail. ' +
        'Behavior: Safe and read-only. Scans standard Riot Games log directories on disk.',
      inputSchema: {
        target: z
          .enum(['client', 'ux', 'game'])
          .default('client')
          .describe('Log target subsystem: "client" (LCU logs), "ux" (CEF UI logs), or "game" (Game engine r3dlogs)'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe('Maximum number of sessions to return (1-50, default: 10)')
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
