import { z } from 'zod';
import { ENDPOINTS, GROUPS, filterEndpoints } from './curated.js';
import { guard, ok } from './result.js';

export function registerEndpointsTool(server, ctx) {
  server.registerTool(
    'lol_endpoints',
    {
      title: 'List curated LCU endpoints',
      description:
        'The curated endpoint table: the LCU paths this project actually uses, with the verb, a ' +
        'group, and a one-line description. {placeholder} marks a path parameter. Optional filter is ' +
        'a case-insensitive substring matched against verb, path, group, and description.',
      inputSchema: {
        filter: z.string().optional().describe('e.g. "champ-select", "ready-check", "summoner"')
      }
    },
    guard(async ({ filter }) => {
      const endpoints = filterEndpoints(filter);
      return ok({ total: ENDPOINTS.length, matched: endpoints.length, groups: GROUPS, endpoints });
    }, ctx)
  );
}
