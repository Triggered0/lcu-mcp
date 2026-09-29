import { z } from 'zod';
import { setSummonerSpells } from '../workflow/spells.js';

export function registerWorkflowSpellsTool(server, ctx) {
  server.tool(
    'lol_workflow_spells_set',
    'Set summoner spells (Flash, Ignite, Smite, Teleport, etc.) by name or ID in active champion select.',
    {
      spell1: z.union([z.string(), z.number()]).describe('Primary summoner spell name (e.g. "flash", "ignite") or numeric ID.'),
      spell2: z.union([z.string(), z.number()]).optional().describe('Secondary summoner spell name or numeric ID.')
    },
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true
    },
    async ({ spell1, spell2 }) => {
      try {
        const result = await setSummonerSpells(ctx, { spell1, spell2 });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Summoner spells workflow failed: ${err.message}` }]
        };
      }
    }
  );
}
