import { z } from 'zod';
import { swapBenchChampion } from '../workflow/bench.js';

export function registerWorkflowBenchTool(server, ctx) {
  server.tool(
    'lol_workflow_champ_select_bench',
    'Swap your active champion with a champion from the ARAM bench by name or ID.',
    {
      champion: z.union([z.string(), z.number()]).describe('Champion name or numeric ID to swap from the ARAM bench.')
    },
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true
    },
    async ({ champion }) => {
      try {
        const result = await swapBenchChampion(ctx, { champion });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Bench swap failed: ${err.message}` }]
        };
      }
    }
  );
}
