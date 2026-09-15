import { z } from 'zod';
import { ENDPOINTS, GROUPS, filterEndpoints } from './curated.js';
import { guard, ok } from './result.js';

export function registerEndpointsTool(server, ctx) {
  server.registerTool(
    'lol_endpoints',
    {
      title: 'List curated LCU endpoints',
      description:
        'Search the curated catalog of League Client Update (LCU) REST API endpoints commonly used for automation and monitoring. ' +
        'Returns matching endpoint paths, HTTP verbs, functional groups, and summary descriptions. ' +
        'Use this tool to quickly discover available endpoints by keyword (e.g. "champ-select", "lobby", "summoner"). ' +
        'For full OpenAPI/Swagger schema definitions, parameter types, or data models, use lol_schema instead. ' +
        'Prerequisite: Works offline without requiring an active League client connection.',
      inputSchema: {
        filter: z.string().optional().describe('Case-insensitive substring filter matching verb, path, group, or description, e.g. "champ-select" or "ready-check"')
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    guard(async ({ filter }) => {
      const endpoints = filterEndpoints(filter);
      return ok({ total: ENDPOINTS.length, matched: endpoints.length, groups: GROUPS, endpoints });
    }, ctx)
  );
}
