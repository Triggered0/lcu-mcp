import { z } from 'zod';
import { guard, ok } from './result.js';

export function registerConsoleTools(server, ctx) {
  server.registerTool(
    'lol_cdp_console_start',
    {
      title: 'Start tailing the client console',
      description:
        'Attach to the client renderer and begin buffering console output and uncaught ' +
        'exceptions in the background, re-attaching automatically when the renderer reloads and ' +
        'the target id changes. Call this BEFORE the thing you want to capture: the buffer only ' +
        'holds what arrived after it started.',
      inputSchema: {}
    },
    guard(async () => ok(await ctx.consoleTailer.start()), ctx)
  );

  server.registerTool(
    'lol_cdp_console_tail',
    {
      title: 'Read buffered client console output',
      description:
        'Return buffered console entries after your cursor. Times are epoch milliseconds: "ts" ' +
        'is this process\'s anchored clock, "pageTs" is the renderer\'s own stamp, and their ' +
        'difference is a delivery-latency signal. "reattach" entries mark renderer reloads and ' +
        'survive every filter, because a reload is context for whatever you are reading. Errors ' +
        'if the tailer is not running rather than returning an empty result.',
      inputSchema: {
        since: z.number().optional().describe('lower bound on ts, epoch milliseconds'),
        until: z.number().optional().describe('upper bound on ts, epoch milliseconds'),
        cursor: z.number().int().min(0).optional().describe('seq cursor from a previous tail'),
        limit: z.number().int().min(1).max(2000).optional().describe('max entries, default 100'),
        level: z.string().optional().describe('console severity, e.g. "error" or "warning"'),
        targetId: z.string().optional().describe('restrict to one renderer incarnation'),
        text: z.string().optional().describe('case-insensitive substring of the message')
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
      description: 'Detach and close the tailer socket. Buffered entries are discarded with it.',
      inputSchema: {}
    },
    guard(async () => ok(ctx.consoleTailer.stop()), ctx)
  );
}
