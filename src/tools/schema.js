import { z } from 'zod';
import { guard, ok } from './result.js';

export function registerSchemaTools(server, ctx) {
  server.registerTool(
    'lol_schema',
    {
      title: 'Query LCU OpenAPI/Swagger schema',
      description:
        "Inspect internal LCU API endpoint signatures, parameters, request bodies, and models using the client's live OpenAPI/Swagger v2 specification.",
      inputSchema: {
        path: z.string().optional().describe('LCU path or keyword to search (e.g. /lol-lobby/v2/lobby or "gameflow")'),
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional().describe('Filter operations by HTTP method'),
        model: z.string().optional().describe('Look up a specific definition/model schema name (e.g. "LolLobbyLobbyDto")'),
        refresh: z.boolean().default(false).describe('Force re-fetch the swagger schema from the League Client')
      }
    },
    guard(async ({ path, method, model, refresh = false } = {}) => {
      const result = await ctx.schema.query({ path, method, model, refresh });
      return ok(result);
    }, ctx)
  );
}
