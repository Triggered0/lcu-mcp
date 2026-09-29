import { getLiveCombatAnalytics } from '../analytics/live.js';

export function registerLiveAnalyticsTools(server, ctx) {
  server.tool(
    'lol_analytics_live_combat',
    'Real-time combat telemetry and team score differentials from the in-match Live Game Engine.',
    {},
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    async () => {
      try {
        const result = await getLiveCombatAnalytics(ctx.gameClient);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Live combat analytics failed: ${err.message}` }]
        };
      }
    }
  );
}
