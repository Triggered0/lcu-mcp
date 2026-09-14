import { z } from 'zod';
import { guard, ok } from './result.js';
import { acceptReadyCheck } from '../workflow/matchmaking.js';
import { pickOrBanChampion } from '../workflow/champ_select.js';
import { setRunePage } from '../workflow/runes.js';
import { createLobby } from '../workflow/lobby.js';

export function registerWorkflowTools(server, ctx) {
  server.registerTool(
    'lol_workflow_matchmaking_accept',
    {
      title: 'Accept matchmaking ready check',
      description: 'Checks matchmaking ready check status and accepts if match is found.',
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    guard(async () => {
      const result = await acceptReadyCheck(ctx.lcu);
      return ok(result);
    }, ctx)
  );

  server.registerTool(
    'lol_workflow_champ_select',
    {
      title: 'Pick, hover, or ban champion in champion select',
      description:
        'Resolves local player action in active champion select, chooses champion by name or ID, and hovers or locks in.',
      inputSchema: {
        champion: z.union([z.string(), z.number()]).describe('Champion name (e.g. "Aatrox", "Yasuo") or numeric ID'),
        type: z.enum(['pick', 'ban']).default('pick'),
        completed: z.boolean().default(true)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    guard(async ({ champion, type, completed }) => {
      const result = await pickOrBanChampion(ctx.lcu, ctx.staticData, { champion, type, completed });
      return ok(result);
    }, ctx)
  );

  server.registerTool(
    'lol_workflow_runes_set',
    {
      title: 'Set or update active rune/perk page',
      description:
        'Creates or updates an editable rune page with specified primary/sub styles and perk IDs and sets it active.',
      inputSchema: {
        name: z.string().default('Antigravity Runes'),
        primaryStyleId: z.number().int(),
        subStyleId: z.number().int(),
        selectedPerkIds: z.array(z.number().int()).min(1),
        replace: z.boolean().default(true)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    guard(async ({ name, primaryStyleId, subStyleId, selectedPerkIds, replace }) => {
      const result = await setRunePage(ctx.lcu, { name, primaryStyleId, subStyleId, selectedPerkIds, replace });
      return ok(result);
    }, ctx)
  );

  server.registerTool(
    'lol_workflow_lobby',
    {
      title: 'Create game lobby and optionally start matchmaking',
      description:
        'Creates a custom or matchmade lobby for a queue (e.g. 420 for Ranked Solo, 450 for ARAM) and optionally starts matchmaking queue search.',
      inputSchema: {
        queueId: z.number().int(),
        startMatchmaking: z.boolean().default(false)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    guard(async ({ queueId, startMatchmaking }) => {
      const result = await createLobby(ctx.lcu, { queueId, startMatchmaking });
      return ok(result);
    }, ctx)
  );
}
