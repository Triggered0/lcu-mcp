import { z } from 'zod';
import { getPlayerAnalytics } from '../analytics/player.js';

export function registerPlayerAnalyticsTools(server, ctx) {
  server.tool(
    'lol_analytics_player',
    'Evaluate comprehensive player ranked performance, winrate trends, KDA, CS/min, and champion pool from local client data.',
    {
      puuid: z.string().optional().describe('Target player PUUID. When omitted, evaluates currently logged-in summoner.'),
      matchCount: z.number().int().min(1).max(20).optional().describe('Number of recent matches to evaluate (1 to 20, default 10).')
    },
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    async ({ puuid, matchCount }) => {
      try {
        const result = await getPlayerAnalytics(ctx.lcu, ctx.staticData, { puuid, matchCount });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Player analytics evaluation failed: ${err.message}` }]
        };
      }
    }
  );
}
