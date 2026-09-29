import { z } from 'zod';
import { triggerPlayAgain, submitHonor } from '../workflow/postgame.js';

export function registerWorkflowPostgameTools(server, ctx) {
  server.tool(
    'lol_workflow_play_again',
    'Recreate previous game lobby from the End of Game screen.',
    {},
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true
    },
    async () => {
      try {
        const result = await triggerPlayAgain(ctx);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Play again workflow failed: ${err.message}` }]
        };
      }
    }
  );

  server.tool(
    'lol_workflow_honor',
    'Submit post-game honor vote for an eligible teammate.',
    {
      target: z.union([z.string(), z.number()]).describe('Target teammate summoner name, gameName, or summonerId.'),
      honorCategory: z.enum(['COOL', 'SHOTCALLER', 'HEART']).default('HEART').describe('Honor badge category ("COOL", "SHOTCALLER", or "HEART", default "HEART").')
    },
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true
    },
    async ({ target, honorCategory }) => {
      try {
        const result = await submitHonor(ctx, { target, honorCategory });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Honor workflow failed: ${err.message}` }]
        };
      }
    }
  );
}
