import { z } from 'zod';
import { checkWrite } from '../allowlist.js';
import { fail, guard, ok } from './result.js';

const pathSchema = z
  .string()
  .startsWith('/', 'LCU paths must start with "/", e.g. /lol-gameflow/v1/gameflow-phase');

export function registerPassthroughTools(server, ctx) {
  server.registerTool(
    'lol_get',
    {
      title: 'GET an LCU endpoint',
      description:
        'GET any LCU path and return { status, body }. Always allowed. ' +
        'Use lol_endpoints to discover the paths this client is known to expose.',
      inputSchema: { path: pathSchema }
    },
    guard(async ({ path }) => ok(await ctx.lcu.get(path)), ctx)
  );

  server.registerTool(
    'lol_request',
    {
      title: 'Call an LCU endpoint with any verb',
      description:
        'Send any HTTP verb to an LCU path. GET and HEAD are always allowed; every other verb ' +
        'must match an entry in the write allowlist, otherwise the call is refused with the exact ' +
        'config line that would permit it.',
      inputSchema: {
        method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']),
        path: pathSchema,
        body: z.unknown().optional().describe('JSON request body; omit for verbs that take none')
      }
    },
    guard(async ({ method, path, body }) => {
      const verdict = checkWrite(method, path, ctx.config.writeAllowlist);
      if (!verdict.allowed) return fail(`${verdict.message} (config file: ${ctx.config.configPath})`);
      return ok(await ctx.lcu.request(method, path, body));
    }, ctx)
  );
}
