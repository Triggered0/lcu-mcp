import { z } from 'zod';
import { getMatchDetailAnalytics } from '../analytics/match.js';

export function registerMatchAnalyticsTools(server, ctx) {
  server.tool(
    'lol_analytics_match_detail',
    'Perform deep post-game analytical breakdown including team damage share %, gold efficiency, objective ratios, and player KPI.',
    {
      gameId: z.number().int().optional().describe('Game ID to analyze. When omitted, automatically inspects the most recently completed match.')
    },
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    async ({ gameId }) => {
      try {
        const result = await getMatchDetailAnalytics(ctx.lcu, ctx.staticData, { gameId });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Match detail analytics failed: ${err.message}` }]
        };
      }
    }
  );
}
