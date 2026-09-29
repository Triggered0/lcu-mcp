import { extractPerformanceMetrics } from '../diagnostics/performance.js';
import { guard, ok } from './result.js';

export function registerCdpPerformanceTool(server, ctx) {
  server.registerTool(
    'lol_cdp_performance',
    {
      title: 'Profile CEF performance and memory metrics',
      description:
        'Inspect Chromium Embedded Framework (CEF) performance and memory metrics for the League client frontend. ' +
        'Gathers JS heap size, DOM node count, layout count, recalc style count, task and script duration, and flags memory pressure warnings. ' +
        'Use this tool to detect memory leaks, detached DOM nodes, or renderer lag in frontend plugins. ' +
        'Prerequisite: Requires Chrome DevTools Protocol (CDP) enabled via Pengu Loader; check lol_status if connection fails. (Note: Pengu Loader is required for CDP tools; standard LCU REST, events, and workflows work without it).',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    guard(async () => {
      await ctx.cdp.send('Performance.enable');
      const response = await ctx.cdp.send('Performance.getMetrics');
      const rawMetrics = Array.isArray(response) ? response : response?.metrics ?? [];
      const metrics = extractPerformanceMetrics(rawMetrics);
      return ok(metrics);
    }, ctx)
  );
}
