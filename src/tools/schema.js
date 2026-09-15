import { z } from 'zod';
import { guard, ok } from './result.js';

export function registerSchemaTools(server, ctx) {
  server.registerTool(
    'lol_schema',
    {
      title: 'Query LCU OpenAPI/Swagger schema',
      description:
        "Inspect internal LCU API endpoint signatures, parameters, request bodies, and data models using the League client's live OpenAPI/Swagger v2 specification. " +
        "Use this tool to find the exact request schema, parameter types, or response models before invoking lol_request. " +
        "For a lightweight list of common endpoints, use lol_endpoints instead. For static game assets (champions, items, runes), use lol_static instead. " +
        "Prerequisite: League client must be running to fetch swagger doc; cached in memory after first load.",
      inputSchema: {
        path: z.string().optional().describe('LCU path or keyword to search (e.g. "/lol-lobby/v2/lobby" or "gameflow")'),
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional().describe('Filter operations by HTTP method'),
        model: z.string().optional().describe('Look up a specific definition/model schema name (e.g. "LolLobbyLobbyDto")'),
        refresh: z.boolean().default(false).describe('Force re-fetch the swagger schema from the League Client')
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    guard(async ({ path, method, model, refresh = false } = {}) => {
      const result = await ctx.schema.query({ path, method, model, refresh });
      return ok(result);
    }, ctx)
  );
}
