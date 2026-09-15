import { z } from 'zod';
import { guard, ok } from './result.js';

export function registerNetworkTools(server, ctx) {
  server.registerTool(
    'lol_cdp_network_start',
    {
      title: 'Start recording client HTTP requests',
      description:
        'Attach to the League Client renderer via Chrome DevTools Protocol (CDP) and begin capturing outgoing and incoming HTTP/HTTPS network requests into an in-memory buffer. ' +
        'Use this tool to monitor REST traffic, measure endpoint latency, or debug failed API calls made by the client UI. ' +
        'To inspect captured requests, call lol_cdp_network_tail or lol_cdp_network_summary. ' +
        'To read response payload bodies, use lol_cdp_network_body with a request ID. ' +
        'For WebSocket events, use lol_events_* or lol_wamp_record_* instead. ' +
        'Behavior: Captures request metadata, headers, status codes, and timing. Prerequisite: Active CDP connection.',
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
        'Retrieve captured HTTP network requests from the in-memory buffer, filtered by status, URL pattern, or HTTP method. ' +
        'Use this tool to inspect recent client network calls and identify 4xx/5xx errors or hung requests. ' +
        'Prerequisite: Must call lol_cdp_network_start first; fails if network recording is not running. ' +
        'To fetch full response bodies, pass returned request IDs to lol_cdp_network_body. For aggregated traffic statistics, use lol_cdp_network_summary instead. ' +
        'Behavior: Returns completed requests and active in-flight requests.',
      inputSchema: {
        since: z.number().optional().describe('Lower timestamp bound in epoch milliseconds; excludes older requests'),
        until: z.number().optional().describe('Upper timestamp bound in epoch milliseconds; excludes newer requests'),
        cursor: z.number().int().min(0).optional().describe('Sequence cursor from a previous tail call for incremental reading'),
        limit: z.number().int().min(1).max(2000).optional().describe('Maximum entries to return (1-2000, default: 100)'),
        urlContains: z.string().optional().describe('Case-insensitive substring filter matching request URLs, e.g. "/lol-champ-select/"'),
        method: z.string().optional().describe('HTTP method filter matching verbs case-insensitively, e.g. "GET" or "POST"'),
        status: z.number().int().optional().describe('Exact HTTP response status code to match, e.g. 404 or 500'),
        minStatus: z.number().int().optional().describe('Minimum HTTP status code threshold; pass 400 to find all client and server errors'),
        type: z.string().optional().describe('CDP resource type filter, e.g. "Fetch", "XHR", "Document", or "Script"'),
        failedOnly: z.boolean().optional().describe('If true, filters strictly for low-level transport/network failures (excludes HTTP 4xx/5xx)'),
        targetId: z.string().optional().describe('Filter requests to a specific CDP renderer target ID')
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
        'Fetch the raw response body payload for a specific captured network request ID from the live renderer. ' +
        'Use this tool after lol_cdp_network_tail to examine the raw payload or JSON response of an interesting request. ' +
        'For high-level request metadata or status codes without bodies, lol_cdp_network_tail suffices. ' +
        'Behavior: Reaches live renderer cache. Prerequisite: Request must have been captured in the current renderer session; fails if evicted or client reloaded.',
      inputSchema: {
        requestId: z.string().describe('Unique request identifier returned in a lol_cdp_network_tail entry')
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
        'Aggregate and summarize captured HTTP requests by method and endpoint URL pattern with status breakdown, total byte volume, and median duration. ' +
        'Use this tool to analyze high-volume client polling traffic, discover top endpoints, or spot systemic failure rates over time without reading raw request logs. ' +
        'For individual request inspection with timestamps, use lol_cdp_network_tail instead. ' +
        'Behavior: Safe and read-only; summarizes in-memory buffer without consuming or altering stream cursors.',
      inputSchema: {
        since: z.number().optional().describe('Lower timestamp bound in epoch milliseconds; excludes older requests'),
        until: z.number().optional().describe('Upper timestamp bound in epoch milliseconds; excludes newer requests'),
        urlContains: z.string().optional().describe('Case-insensitive substring filter matching request URLs'),
        method: z.string().optional().describe('HTTP method filter matching verbs case-insensitively, e.g. "GET" or "POST"')
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
      description:
        'Detach from the League Client renderer and terminate the network traffic recording session. ' +
        'Use this tool when network analysis is complete to release memory and close the CDP monitoring session. ' +
        'Behavior: Discards in-memory network buffers. Idempotent; safe to call when already stopped.',
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
