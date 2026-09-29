import { z } from 'zod';
import { swapBenchChampion } from '../workflow/bench.js';
import { guard, ok } from './result.js';

export function registerWorkflowBenchTool(server, ctx) {
  server.registerTool(
    'lol_workflow_champ_select_bench',
    {
      title: 'Swap champion with ARAM bench',
      description:
        'Swaps your active champion with an available champion on the ARAM bench by name or numeric champion ID. ' +
        'Use this tool during ARAM champion select when a preferred champion becomes available on the shared team bench. ' +
        'For regular draft pick, hover, or ban actions, use lol_workflow_champ_select instead. For setting summoner spells, use lol_workflow_spells_set. ' +
        'Behavior: Mutates active player champion assignment; fails cleanly if target champion is not on the bench or champ select is inactive. ' +
        'Needs "POST /lol-champ-select/v1/session/bench/swap/*" on the write allowlist.',
      inputSchema: {
        champion: z.union([z.string(), z.number()]).describe('Champion name (e.g. "Ahri", "Yasuo") or numeric ID on the bench.')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    guard(async ({ champion }) => {
      const result = await swapBenchChampion(ctx, { champion });
      return ok(result);
    }, ctx)
  );
}
