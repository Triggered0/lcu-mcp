import { z } from 'zod';
import { getPlayerAnalytics } from '../analytics/player.js';
import { guard, ok } from './result.js';

export function registerPlayerAnalyticsTools(server, ctx) {
  server.registerTool(
    'lol_analytics_player',
    {
      title: 'Analyze summoner ranked and match history performance',
      description:
        'Evaluates comprehensive summoner profile analytics including ranked tiers, LP, winrate %, average KDA, CS per minute, and primary champion pool. ' +
        'Use this tool when assessing a player\'s skill level, ranked progression, or preferred champions before or after matches. ' +
        'For viewing individual recent matches in a compact list, use lol_analytics_match_history instead. For in-depth post-match breakdown, use lol_analytics_match_detail. ' +
        'Behavior: Safe and read-only; queries local client cache and REST endpoints without modifying game state. Returns structured performance metrics.',
      inputSchema: {
        puuid: z.string().optional().describe('Target player PUUID. When omitted, evaluates currently logged-in summoner.'),
        matchCount: z.number().int().min(1).max(20).optional().describe('Number of recent matches to evaluate (1 to 20, default 10).')
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    guard(async ({ puuid, matchCount }) => {
      const result = await getPlayerAnalytics(ctx.lcu, ctx.staticData, { puuid, matchCount });
      return ok(result);
    }, ctx)
  );
}
