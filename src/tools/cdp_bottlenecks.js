import { z } from 'zod';
import { analyzeBottlenecks } from '../diagnostics/bottlenecks.js';
import { guard, ok } from './result.js';

export function registerNetworkBottlenecksTool(server, ctx) {
  server.registerTool(
    'lol_cdp_network_bottlenecks',
    {
      title: 'Analyze network latency bottlenecks and failed asset loads',
      description:
        'Analyzes captured HTTP network requests to identify latency bottlenecks, slow endpoint patterns, and failed asset loads. ' +
        'Calculates P50, P90, and P99 latencies per normalized endpoint, extracts slowest requests exceeding a threshold duration with initiator stack traces, and groups HTTP 4xx/5xx or transport errors. ' +
        'Use this tool to diagnose frontend lag, sluggish LCU REST endpoints, or broken plugin scripts and missing icons. ' +
        'Prerequisite: Network recording must be active; call lol_cdp_network_start first.',
      inputSchema: {
        thresholdMs: z
          .number()
          .min(0)
          .default(200)
          .optional()
          .describe('Minimum duration in milliseconds for a request to be considered slow (default: 200)'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .default(20)
          .optional()
          .describe('Maximum number of slowest requests to return (default: 20)'),
        includeInitiators: z
          .boolean()
          .default(true)
          .optional()
          .describe('Whether to include script initiator stack traces (default: true)')
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    guard(
      async ({ thresholdMs = 200, limit = 20, includeInitiators = true } = {}) => {
        const tailed = ctx?.networkTailer?.tail ? ctx.networkTailer.tail({ limit: 1000 }) : { entries: [] };
        const entries = Array.isArray(tailed?.entries) ? tailed.entries : [];
        const result = analyzeBottlenecks(entries, { thresholdMs, limit, includeInitiators });
        return ok(result);
      },
      ctx
    )
  );
}
