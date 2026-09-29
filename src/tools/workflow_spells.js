import { z } from 'zod';
import { setSummonerSpells } from '../workflow/spells.js';
import { guard, ok } from './result.js';

export function registerWorkflowSpellsTool(server, ctx) {
  server.registerTool(
    'lol_workflow_spells_set',
    {
      title: 'Configure summoner spells in champion select',
      description:
        'Resolves summoner spell names (case-insensitive, e.g. "flash", "ignite", "smite", "teleport") or integer IDs and updates the player\'s spell selection in active champion select. ' +
        'Use this tool during champion select to equip appropriate summoner spells for your role. ' +
        'For configuring rune pages, use lol_workflow_runes_set instead. For picking or hovering champions, use lol_workflow_champ_select. ' +
        'Behavior: Mutates player spell slots; idempotent when setting the same spells. Requires champion select session to be active. ' +
        'Needs "PATCH /lol-champ-select/v1/session/my-selection" on the write allowlist.',
      inputSchema: {
        spell1: z.union([z.string(), z.number()]).describe('Primary summoner spell name (e.g. "flash", "ignite") or numeric ID.'),
        spell2: z.union([z.string(), z.number()]).optional().describe('Secondary summoner spell name or numeric ID.')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    guard(async ({ spell1, spell2 }) => {
      const result = await setSummonerSpells(ctx, { spell1, spell2 });
      return ok(result);
    }, ctx)
  );
}
