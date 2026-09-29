import { z } from 'zod';
import { getMatchDetailAnalytics } from '../analytics/match.js';
import { guard, ok } from './result.js';

export function registerMatchAnalyticsTools(server, ctx) {
  server.registerTool(
    'lol_analytics_match_detail',
    {
      title: 'Deep post-match breakdown and objective analytics',
      description:
        'Calculates advanced post-game metrics including player damage share %, gold efficiency, kill participation (KP %), vision score, and team objective counts (dragons, barons, towers). ' +
        'Use this tool when analyzing the decisive factors, individual carrying performance, or throws of a specific completed match. ' +
        'For viewing multiple recent matches in brief, use lol_analytics_match_history instead. For live in-progress matches, use lol_analytics_live_combat. ' +
        'Behavior: Safe and read-only; automatically defaults to the most recent match if gameId is omitted. Returns structured objective and player breakdowns.',
      inputSchema: {
        gameId: z.number().int().optional().describe('Game ID to analyze. When omitted, automatically inspects the most recently completed match.')
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    guard(async ({ gameId }) => {
      const result = await getMatchDetailAnalytics(ctx.lcu, ctx.staticData, { gameId });
      return ok(result);
    }, ctx)
  );
}
