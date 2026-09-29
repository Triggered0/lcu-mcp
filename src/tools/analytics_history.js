import { z } from 'zod';
import { getMatchHistory } from '../analytics/history.js';

export function registerMatchHistoryTools(server, ctx) {
  server.tool(
    'lol_analytics_match_history',
    'Fetch a compact, token-efficient summary list of recent match history games for a summoner.',
    {
      puuid: z.string().optional().describe('Target player PUUID. When omitted, fetches current summoner history.'),
      limit: z.number().int().min(1).max(20).optional().describe('Maximum number of matches to retrieve (1 to 20, default 10).'),
      queueId: z.number().int().optional().describe('Optional queue filter ID (e.g. 420 for Ranked Solo, 450 for ARAM).')
    },
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    async ({ puuid, limit, queueId }) => {
      try {
        const result = await getMatchHistory(ctx.lcu, ctx.staticData, { puuid, limit, queueId });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Match history retrieval failed: ${err.message}` }]
        };
      }
    }
  );
}
