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
        'Fetch full real-time live game state from the in-match game engine (scores, players, items, events, game time). ' +
        'By default returns a compact summary to save tokens; set format to "raw" for the complete ~100KB payload.',
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
      description: 'Check match status and general game clock, mode, and map from the live game engine.',
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
      description: 'Fetch real-time stats, abilities, items, and runes for the active player or a specific summoner.',
      inputSchema: {
        name: z.string().optional().describe('Summoner name or Riot ID, or omit for local active player')
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
      description: 'Retrieve in-game events (kills, objectives, aces, structures) with incremental cursor support.',
      inputSchema: {
        afterId: z.number().int().min(0).optional().describe('Event ID cursor to fetch events that occurred after')
      },
      annotations: GAME_TOOL_ANNOTATIONS
    },
    guard(async ({ afterId } = {}) => {
      const events = await ctx.gameClient.getEvents(afterId);
      return ok(events);
    }, ctx)
  );
}
