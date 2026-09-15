import { z } from 'zod';
import { checkWrite } from '../allowlist.js';
import { fail, guard, ok } from './result.js';

const pathSchema = z
  .string()
  .startsWith('/', 'LCU paths must start with "/", e.g. /lol-gameflow/v1/gameflow-phase')
  .describe('Absolute LCU REST endpoint path starting with "/", e.g. "/lol-gameflow/v1/gameflow-phase" or "/lol-summoner/v1/current-summoner"');

export function registerPassthroughTools(server, ctx) {
  server.registerTool(
    'lol_get',
    {
      title: 'GET an LCU endpoint',
      description:
        'Send a read-only HTTP GET request to any internal League Client Update (LCU) REST API endpoint and return { status, body }. ' +
        'Use this tool to inspect live client state such as summoner profile, lobby members, or gameflow phase. ' +
        'For mutating actions (POST, PUT, PATCH, DELETE), use lol_request instead. ' +
        'To discover supported endpoint paths, use lol_endpoints or lol_schema. ' +
        'Prerequisite: League client must be running. Safe and idempotent; requires no write allowlist entries.',
      inputSchema: { path: pathSchema },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    guard(async ({ path }) => ok(await ctx.lcu.get(path)), ctx)
  );

  server.registerTool(
    'lol_request',
    {
      title: 'Call an LCU endpoint with any verb',
      description:
        'Send an HTTP request with any verb (GET, HEAD, POST, PUT, PATCH, DELETE) to an internal League Client Update (LCU) REST endpoint. ' +
        'Use this tool to perform client mutations or call endpoints not covered by dedicated workflow tools. ' +
        'For safe read-only queries, prefer lol_get. For common automated actions like champion selection or lobby creation, prefer lol_workflow_* tools. ' +
        'Behavior: GET and HEAD are always allowed. Mutating verbs require matching entries in the write allowlist; unauthorized requests are rejected before execution.',
      inputSchema: {
        method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']).describe('HTTP verb to execute against the LCU endpoint'),
        path: pathSchema,
        body: z.unknown().optional().describe('JSON request body payload; omit for verbs that take none (such as GET or DELETE)')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    guard(async ({ method, path, body }) => {
      const verdict = checkWrite(method, path, ctx.config.writeAllowlist);
      if (!verdict.allowed) return fail(`${verdict.message} (config file: ${ctx.config.configPath})`);
      return ok(await ctx.lcu.request(method, path, body));
    }, ctx)
  );
}
