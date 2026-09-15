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
        'A lock-in cannot be undone. Needs "PATCH /lol-champ-select/v1/session/actions/*" on the write allowlist.',
      inputSchema: {
        champion: z
          .union([z.string().trim().min(1), z.number()])
          .describe('Champion name (e.g. "Aatrox", "Yasuo") or numeric ID'),
        type: z.enum(['pick', 'ban']).default('pick'),
        completed: z.boolean().default(true)
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
        'Needs "POST /lol-perks/v1/pages" and "PUT /lol-perks/v1/pages/*" on the write allowlist.',
      inputSchema: {
        name: z.string().default('Antigravity Runes'),
        primaryStyleId: z.number().int(),
        subStyleId: z.number().int(),
        selectedPerkIds: z.array(z.number().int()).min(1),
        replace: z.boolean().default(true)
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
        'created from nothing, that lobby is closed again. Needs "POST /lol-lobby/v2/lobby" (and, for ' +
        'startMatchmaking, "POST /lol-lobby/v2/lobby/matchmaking/search" plus "DELETE /lol-lobby/v2/lobby" ' +
        'to undo) on the write allowlist.',
      inputSchema: {
        queueId: z.number().int(),
        startMatchmaking: z.boolean().default(false)
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
