import { z } from 'zod';
import { guard, ok } from './result.js';
import { STATIC_KINDS } from '../lcu/static.js';

export function registerStaticTools(server, ctx) {
  server.registerTool(
    'lol_static',
    {
      title: 'Resolve static game data ids to names',
      description:
        'Resolve numeric game data ids to names using the static documents the League client serves locally. Use this to turn a raw championId, item id, perk id, summoner spell id, map id, or queue id from another tool into something readable, or to search those documents by name.',
      inputSchema: {
        kind: z.enum(STATIC_KINDS).describe('Which static document to query'),
        ids: z.array(z.number()).optional().describe('Exact ids to resolve (e.g. [157] for a championId)'),
        query: z.string().optional().describe('Case-insensitive substring match against the entry name'),
        fields: z
          .array(z.string())
          .optional()
          .describe('Extra fields to include beyond the default {id, name}, e.g. ["roles"]'),
        limit: z.number().int().min(1).max(200).default(50).describe('Maximum entries to return'),
        offset: z.number().int().min(0).default(0).describe('Entries to skip, to page past a truncated result'),
        refresh: z.boolean().default(false).describe('Force re-fetch of this document from the client')
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    guard(async ({ kind, ids, query, fields, limit = 50, offset = 0, refresh = false } = {}) => {
      const result = await ctx.staticData.query({ kind, ids, query, fields, limit, offset, refresh });
      return ok(result);
    }, ctx)
  );
}
