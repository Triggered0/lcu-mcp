import { z } from 'zod';
import { checkWrite } from '../allowlist.js';
import { guard, ok } from './result.js';
import { acceptReadyCheck } from '../workflow/matchmaking.js';
import { pickOrBanChampion } from '../workflow/champ_select.js';
import { setRunePage } from '../workflow/runes.js';
import { createLobby } from '../workflow/lobby.js';

// Macros issue the same client mutations as lol_request, so they go through the
// same gate. The write allowlist is the one place a user declares what this
// server may change; a macro that reached past it would make that promise a lie.
function gatedClient(ctx) {
  return {
    get: (path) => ctx.lcu.get(path),
    request: (method, path, body) => {
      const verdict = checkWrite(method, path, ctx.config.writeAllowlist);
      if (!verdict.allowed) {
        throw new Error(`${verdict.message} (config file: ${ctx.config.configPath})`);
      }
      return ctx.lcu.request(method, path, body);
    }
  };
}

export function registerWorkflowTools(server, ctx) {
  server.registerTool(
    'lol_workflow_matchmaking_accept',
    {
      title: 'Accept matchmaking ready check',
      description:
        'Checks matchmaking ready check status and accepts if match is found. ' +
        'Use this tool when automated match acceptance is needed during queue pop. ' +
        'For creating a lobby or initiating matchmaking queue search, use lol_workflow_lobby instead. For champion selection, use lol_workflow_champ_select. ' +
        'Behavior: Safe and idempotent; no-op if no ready check is active. ' +
        'Needs "POST /lol-matchmaking/v1/ready-check/accept" on the write allowlist.',
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    guard(async () => {
      const result = await acceptReadyCheck(gatedClient(ctx));
      return ok(result);
    }, ctx)
  );

  server.registerTool(
    'lol_workflow_champ_select',
    {
      title: 'Pick, hover, or ban champion in champion select',
      description:
        'Resolves local player action in active champion select, chooses champion by name or ID, and hovers or locks in. ' +
        'Use this tool during draft or blind pick phases to hover or confirm champion selection or ban. ' +
        'For adjusting rune/perk pages during champ select, use lol_workflow_runes_set instead. For general lobby management, use lol_workflow_lobby. ' +
        'A lock-in cannot be undone. Needs "PATCH /lol-champ-select/v1/session/actions/*" on the write allowlist.',
      inputSchema: {
        champion: z
          .union([z.string().trim().min(1), z.number()])
          .describe('Champion name (e.g. "Aatrox", "Yasuo") or numeric champion ID (e.g. 266, 157)'),
        type: z
          .enum(['pick', 'ban'])
          .default('pick')
          .describe('Action type: "pick" to select champion, or "ban" to ban champion'),
        completed: z
          .boolean()
          .default(true)
          .describe('Whether to immediately lock in (true) or only hover the choice (false)')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    guard(async ({ champion, type, completed }) => {
      const result = await pickOrBanChampion(gatedClient(ctx), ctx.staticData, { champion, type, completed });
      return ok(result);
    }, ctx)
  );

  server.registerTool(
    'lol_workflow_runes_set',
    {
      title: 'Set or update active rune/perk page',
      description:
        'Creates or updates an editable rune page with specified primary/sub styles and perk IDs and sets it active. ' +
        'Reuses an existing page only when its name matches, so pages the user built by hand are left alone. ' +
        'Use this tool before or during champ select to configure runes for a specific champion build. ' +
        'To look up numeric rune IDs from names or styles, query lol_static with kind "perks". ' +
        'Needs "POST /lol-perks/v1/pages" and "PUT /lol-perks/v1/pages/*" on the write allowlist.',
      inputSchema: {
        name: z
          .string()
          .default('Antigravity Runes')
          .describe('Name for the rune page; existing editable page with this name will be updated'),
        primaryStyleId: z
          .number()
          .int()
          .describe('Primary rune path tree ID (e.g. 8000 Precision, 8100 Domination, 8200 Sorcery, 8300 Inspiration, 8400 Resolve)'),
        subStyleId: z
          .number()
          .int()
          .describe('Secondary rune path tree ID (e.g. 8000 Precision, 8100 Domination, 8200 Sorcery, 8300 Inspiration, 8400 Resolve)'),
        selectedPerkIds: z
          .array(z.number().int())
          .min(1)
          .describe('Array of 9 perk IDs (keystone + 3 primary perks + 2 secondary perks + 3 stat shards)'),
        replace: z
          .boolean()
          .default(true)
          .describe('If true, updates existing page with matching name; if false, always creates a new page')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    guard(async ({ name, primaryStyleId, subStyleId, selectedPerkIds, replace }) => {
      const result = await setRunePage(gatedClient(ctx), { name, primaryStyleId, subStyleId, selectedPerkIds, replace });
      return ok(result);
    }, ctx)
  );

  server.registerTool(
    'lol_workflow_lobby',
    {
      title: 'Create game lobby and optionally start matchmaking',
      description:
        'Creates a custom or matchmade lobby for a queue (e.g. 420 for Ranked Solo, 450 for ARAM) and optionally starts matchmaking queue search. ' +
        'Replaces the current lobby if it is on another queue. If the search fails after a lobby was ' +
        'created from nothing, that lobby is closed again. ' +
        'Use this tool to set up queues or queue up with a party. For accepting the ready check when queue pops, use lol_workflow_matchmaking_accept instead. ' +
        'To look up queue IDs, query lol_static with kind "queues". ' +
        'Needs "POST /lol-lobby/v2/lobby" (and, for startMatchmaking, "POST /lol-lobby/v2/lobby/matchmaking/search" plus "DELETE /lol-lobby/v2/lobby" to undo) on the write allowlist.',
      inputSchema: {
        queueId: z
          .number()
          .int()
          .describe('Target queue ID (e.g. 420 for Ranked Solo/Duo, 440 for Ranked Flex, 450 for ARAM, 400 for Normal Draft)'),
        startMatchmaking: z
          .boolean()
          .default(false)
          .describe('Whether to immediately start searching for a match after lobby creation')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    guard(async ({ queueId, startMatchmaking }) => {
      const result = await createLobby(gatedClient(ctx), { queueId, startMatchmaking });
      return ok(result);
    }, ctx)
  );
}
