import { getLiveCombatAnalytics } from '../analytics/live.js';
import { guard, ok } from './result.js';

export function registerLiveAnalyticsTools(server, ctx) {
  server.registerTool(
    'lol_analytics_live_combat',
    {
      title: 'Analyze live combat state and lane differentials',
      description:
        'Extracts real-time combat status, lane gold/level comparisons, match clock, and team score differentials from the in-match Live Game Engine on port 2999. ' +
        'Use this tool during active live games to assess map state, score leads, or lane advantages. ' +
        'For raw live game data or item builds, use lol_game_all or lol_game_player instead. For post-game analysis, use lol_analytics_match_detail. ' +
        'Behavior: Safe and read-only; connects directly to local game client without external network calls. Returns inGame: false if no match is currently running.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    guard(async () => {
      const result = await getLiveCombatAnalytics(ctx.gameClient);
      return ok(result);
    }, ctx)
  );
}
