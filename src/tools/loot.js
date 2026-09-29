import { z } from 'zod';
import { getLootSummary, disenchantLoot } from '../loot/economy.js';
import { guard, ok } from './result.js';

export function registerLootTools(server, ctx) {
  server.registerTool(
    'lol_analytics_loot_summary',
    {
      title: 'Analyze loot inventory and essence values',
      description:
        'Calculates total potential Blue Essence (from champion shards) and Orange Essence (from skin shards) along with shard breakdown in player inventory. ' +
        'Use this tool when evaluating available crafting materials, essence totals, or preparing to disenchant duplicate shards. ' +
        'For executing disenchant recipes, use lol_workflow_loot_disenchant. For general store and catalog purchases, use lol_request. ' +
        'Behavior: Safe and read-only; queries local player loot inventory without modifying items. Returns essence summaries and shard lists.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    guard(async () => {
      const result = await getLootSummary(ctx.lcu);
      return ok(result);
    }, ctx)
  );

  server.registerTool(
    'lol_workflow_loot_disenchant',
    {
      title: 'Disenchant loot shards for essence',
      description:
        'Disenchants specified champion or skin shards by lootId to yield Blue or Orange Essence. ' +
        'Use this tool to convert unwanted or duplicate shards into crafting essence. ' +
        'For viewing total potential essence yields before disenchanting, use lol_analytics_loot_summary first. ' +
        'Behavior: Consumes inventory items; cannot be undone once crafted. ' +
        'Needs "POST /lol-loot/v1/recipes/*/craft" on the write allowlist.',
      inputSchema: {
        lootId: z.string().describe('Exact lootId of shard to disenchant (e.g. "CHAMPION_RENTAL_103").'),
        count: z.number().int().min(1).default(1).describe('Number of shards of this type to disenchant.')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    guard(async ({ lootId, count }) => {
      const result = await disenchantLoot(ctx, { lootId, count });
      return ok(result);
    }, ctx)
  );
}
