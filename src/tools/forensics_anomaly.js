import { z } from 'zod';
import { detectAnomalies } from '../diagnostics/anomaly.js';
import { guard, ok } from './result.js';

export function registerAnomalyTool(server, ctx) {
  server.registerTool(
    'lol_forensics_anomaly_detect',
    {
      title: 'Detect cross-stream telemetry anomalies and client crash signatures',
      description:
        'Scans across active LCU WAMP event recordings, CDP console logs, network requests, and client disk logs to detect anomalies and crash patterns. ' +
        'Identifies frontend exception bursts, LCU HTTP server error clusters (500/503), WebSocket disconnects, and fatal crashes with root-cause hypotheses. ' +
        'Behavior: Safe and read-only. Does not interrupt background loggers or active streams.',
      inputSchema: {
        windowSeconds: z
          .number()
          .int()
          .min(1)
          .max(3600)
          .default(60)
          .optional()
          .describe('Analysis window in seconds to inspect across all streams (1-3600, default: 60)'),
        severityFilter: z
          .enum(['CRITICAL', 'DEGRADED', 'ALL'])
          .optional()
          .describe('Filter returned anomalies by severity level: "CRITICAL", "DEGRADED", or "ALL"')
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
        windowSeconds = 60,
        severityFilter
      } = {}) => {
        let wampEntries = [];
        if (ctx?.recorder?.dump) {
          try {
            const dumped = ctx.recorder.dump({ limit: 1000 });
            wampEntries = dumped?.entries ?? [];
          } catch {
            wampEntries = [];
          }
        }

        let cdpEntries = [];
        if (ctx?.consoleTailer?.tail) {
          try {
            const tailed = ctx.consoleTailer.tail({ limit: 1000 });
            cdpEntries = tailed?.entries ?? [];
          } catch {
            cdpEntries = [];
          }
        }

        let networkEntries = [];
        if (ctx?.networkTailer?.tail) {
          try {
            const tailed = ctx.networkTailer.tail({ limit: 1000 });
            networkEntries = tailed?.entries ?? [];
          } catch {
            networkEntries = [];
          }
        }

        let logEntries = [];
        if (ctx?.logWatcher?.poll) {
          try {
            const polled = ctx.logWatcher.poll({ limit: 1000 });
            logEntries = polled?.entries ?? [];
          } catch {
            logEntries = [];
          }
        }

        const windowMs = (windowSeconds ?? 60) * 1000;
        const result = detectAnomalies({
          wampEntries,
          cdpEntries,
          networkEntries,
          logEntries,
          windowMs
        });

        if (severityFilter && severityFilter !== 'ALL') {
          result.anomalies = result.anomalies.filter(
            (a) => (a.severity || '').toUpperCase() === severityFilter
          );
          result.summary = `${result.summary} (showing ${result.anomalies.length} ${severityFilter} anomalies)`;
        }

        return ok(result);
      },
      ctx
    )
  );
}
