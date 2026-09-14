import { z } from 'zod';
import { guard, ok } from './result.js';

export function registerNetworkTools(server, ctx) {
  server.registerTool(
    'lol_cdp_network_start',
    {
      title: 'Start recording client HTTP requests',
      description:
        'Attach to the client renderer and begin buffering the HTTP requests the client UI makes, ' +
        'with their status, size, timing and the code that issued them. Call this BEFORE the thing ' +
        'you want to capture: the buffer only holds what arrived after it started. Response bodies ' +
        'are not buffered — read them with lol_cdp_network_body.',
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    guard(async () => ok(await ctx.networkTailer.start()), ctx)
  );

  server.registerTool(
    'lol_cdp_network_tail',
    {
      title: 'Read buffered client HTTP requests',
      description:
        'Return buffered requests after your cursor, newest last. One entry per completed request. ' +
        'A request still in flight is reported separately under "inflight", so a hung request stays ' +
        'visible. Note that a 404 arrives as an ordinary response: use minStatus to find 4xx and 5xx, ' +
        'and failedOnly only for transport failures. Errors if the tailer is not running rather than ' +
        'returning an empty result.',
      inputSchema: {
        since: z.number().optional().describe('lower bound on ts, epoch milliseconds'),
        until: z.number().optional().describe('upper bound on ts, epoch milliseconds'),
        cursor: z.number().int().min(0).optional().describe('seq cursor from a previous tail'),
        limit: z.number().int().min(1).max(2000).optional().describe('max entries, default 100'),
        urlContains: z.string().optional().describe('case-insensitive substring of the request url'),
        method: z.string().optional().describe('HTTP method, matched case-insensitively'),
        status: z.number().int().optional().describe('exact HTTP status, e.g. 404'),
        minStatus: z.number().int().optional().describe('minimum HTTP status; use 400 for "what went wrong"'),
        type: z.string().optional().describe('CDP resource type, e.g. "Fetch" or "Document"'),
        failedOnly: z.boolean().optional().describe('only transport failures, not 4xx/5xx responses'),
        targetId: z.string().optional().describe('restrict to one renderer incarnation')
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    guard(async (args = {}) => ok(ctx.networkTailer.tail(args)), ctx)
  );

  server.registerTool(
    'lol_cdp_network_body',
    {
      title: 'Read one response body',
      description:
        'Fetch the response body for a requestId returned by lol_cdp_network_tail. Bodies are not ' +
        'buffered, so this reaches the live renderer: it errors if the renderer has evicted the ' +
        'resource, or if the requestId belongs to a renderer incarnation from before a restart.',
      inputSchema: {
        requestId: z.string().describe('requestId from a lol_cdp_network_tail entry')
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    guard(async ({ requestId }) => ok(await ctx.networkTailer.body(requestId)), ctx)
  );

  server.registerTool(
    'lol_cdp_network_summary',
    {
      title: 'Summarise buffered client HTTP requests',
      description:
        'Aggregate buffered requests by method and url, busiest first, with status counts, total ' +
        'bytes and median duration. The client polls some endpoints several times a second, so this ' +
        'is how an hour of traffic becomes readable, and how you find which endpoints the client ' +
        'actually uses.',
      inputSchema: {
        since: z.number().optional().describe('lower bound on ts, epoch milliseconds'),
        until: z.number().optional().describe('upper bound on ts, epoch milliseconds'),
        urlContains: z.string().optional().describe('case-insensitive substring of the request url'),
        method: z.string().optional().describe('HTTP method, matched case-insensitively')
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    guard(async (args = {}) => ok(ctx.networkTailer.summary(args)), ctx)
  );

  server.registerTool(
    'lol_cdp_network_stop',
    {
      title: 'Stop recording client HTTP requests',
      description: 'Detach and close the tailer socket. Buffered entries are discarded with it.',
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    guard(async () => ok(ctx.networkTailer.stop()), ctx)
  );
}
