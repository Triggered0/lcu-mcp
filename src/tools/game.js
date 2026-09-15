import { z } from 'zod';
import { guard, ok } from './result.js';
import { summarizeGameData } from '../game/summary.js';

const GAME_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
};

export function registerGameTools(server, ctx) {
  server.registerTool(
    'lol_game_all',
    {
      title: 'Live game all data',
      description:
        'Fetch complete real-time in-match game state (scores, player inventories, game time, objectives, events) from the live League game engine. ' +
        'Use this tool during an active match to get full game telemetry. ' +
        'For specific player details, use lol_game_player. For game clock and map only, use lol_game_stats. For in-game kill/objective events, use lol_game_events. ' +
        'For client/lobby data outside matches, use lol_get. ' +
        'Behavior: Prerequisite: Match must be currently running (Live Client Data API on port 2999). Safe and read-only. ' +
        'Returns compact summary by default to conserve tokens; pass "raw" for full ~100KB payload.',
      inputSchema: {
        format: z
          .enum(['summary', 'raw'])
          .default('summary')
          .describe('Output format: "summary" for compact LLM-friendly overview, or "raw" for full ~100KB payload')
      },
      annotations: GAME_TOOL_ANNOTATIONS
    },
    guard(async ({ format = 'summary' } = {}) => {
      const raw = await ctx.gameClient.getAllGameData();
      if (format === 'raw') {
        return ok(raw);
      }
      return ok(summarizeGameData(raw));
    }, ctx)
  );

  server.registerTool(
    'lol_game_stats',
    {
      title: 'Live game stats',
      description:
        'Fetch basic match status, game clock time, game mode, and map ID from the live League game engine. ' +
        'Use this tool to quickly verify whether a match is currently in progress, check elapsed game time, or identify the game mode. ' +
        'For full match telemetry including players and scores, use lol_game_all instead. ' +
        'Behavior: Safe and read-only. Prerequisite: Match must be currently running (port 2999).',
      inputSchema: {},
      annotations: GAME_TOOL_ANNOTATIONS
    },
    guard(async () => {
      const stats = await ctx.gameClient.getGameStats();
      return ok(stats);
    }, ctx)
  );

  server.registerTool(
    'lol_game_player',
    {
      title: 'Live game player data',
      description:
        'Fetch real-time live match statistics, item inventory, abilities, and runes for the active local player or a named summoner. ' +
        'Use this tool to inspect a specific player\'s current gold, level, KDA, items, or rune setup during an active match. ' +
        'For all players in the match at once, use lol_game_all instead. ' +
        'Behavior: Safe and read-only. Prerequisite: Match must be currently in progress (port 2999).',
      inputSchema: {
        name: z.string().optional().describe('Summoner name or Riot ID of target player in the current match; omit to fetch local active player')
      },
      annotations: GAME_TOOL_ANNOTATIONS
    },
    guard(async ({ name } = {}) => {
      const cleanName = typeof name === 'string' ? name.trim() : '';
      if (cleanName) {
        const players = await ctx.gameClient.getPlayerList();
        const query = cleanName.toLowerCase();
        const player = (Array.isArray(players) ? players : []).find((p) => {
          if (!p || typeof p !== 'object') return false;
          const sName = p.summonerName ? String(p.summonerName).toLowerCase() : '';
          const rId = p.riotId ? String(p.riotId).toLowerCase() : '';
          const rGameName = p.riotIdGameName ? String(p.riotIdGameName).toLowerCase() : '';
          return sName === query || rId === query || rGameName === query;
        });
        if (!player) {
          throw new Error(`Player "${name}" not found in current match`);
        }
        return ok(player);
      }
      const active = await ctx.gameClient.getActivePlayer();
      return ok(active);
    }, ctx)
  );

  server.registerTool(
    'lol_game_events',
    {
      title: 'Live game events',
      description:
        'Retrieve in-game events (champion kills, dragon/baron objectives, turret destructions, aces) from the live game engine. ' +
        'Use this tool to track recent in-match actions or feed an event timeline. ' +
        'For full match state including player inventories, use lol_game_all instead. ' +
        'Behavior: Safe and read-only. Supports incremental cursor via afterId. Prerequisite: Active match running on port 2999.',
      inputSchema: {
        afterId: z.number().int().min(0).optional().describe('Event ID cursor from a previous call to fetch only events that occurred after this ID')
      },
      annotations: GAME_TOOL_ANNOTATIONS
    },
    guard(async ({ afterId } = {}) => {
      const events = await ctx.gameClient.getEvents(afterId);
      return ok(events);
    }, ctx)
  );
}
