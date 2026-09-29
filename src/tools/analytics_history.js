import { z } from 'zod';
import { getMatchHistory } from '../analytics/history.js';
import { guard, ok } from './result.js';

export function registerMatchHistoryTools(server, ctx) {
  server.registerTool(
    'lol_analytics_match_history',
    {
      title: 'Fetch compact recent match history list',
      description:
        'Retrieves a token-efficient, compact list of recent match history games for a summoner with resolved champion names, KDA, win/loss, duration, and queue IDs. ' +
        'Use this tool when you need an overview of recent games without filling the context window with raw JSON data. ' +
        'For high-level ranked stats and winrates, use lol_analytics_player instead. For a deep analytical dive into a single game\'s damage and objectives, use lol_analytics_match_detail. ' +
        'Behavior: Safe and read-only; queries local client match history and static champion data. Returns an array of concise match objects.',
      inputSchema: {
        puuid: z.string().optional().describe('Target player PUUID. When omitted, fetches current summoner history.'),
        limit: z.number().int().min(1).max(20).optional().describe('Maximum number of matches to retrieve (1 to 20, default 10).'),
        queueId: z.number().int().optional().describe('Optional queue filter ID (e.g. 420 for Ranked Solo, 450 for ARAM).')
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    guard(async ({ puuid, limit, queueId }) => {
      const result = await getMatchHistory(ctx.lcu, ctx.staticData, { puuid, limit, queueId });
      return ok(result);
    }, ctx)
  );
}
