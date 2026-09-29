import { z } from 'zod';
import { getLootSummary, disenchantLoot } from '../loot/economy.js';

export function registerLootTools(server, ctx) {
  server.tool(
    'lol_analytics_loot_summary',
    'Calculate total Blue and Orange Essence yields from inventory champion and skin shards.',
    {},
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    async () => {
      try {
        const result = await getLootSummary(ctx.lcu);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Loot summary failed: ${err.message}` }]
        };
      }
    }
  );

  server.tool(
    'lol_workflow_loot_disenchant',
    'Disenchant a specific champion or skin loot shard for essence.',
    {
      lootId: z.string().describe('Exact lootId of shard to disenchant (e.g. "CHAMPION_RENTAL_103").'),
      count: z.number().int().min(1).default(1).describe('Number of shards of this type to disenchant.')
    },
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true
    },
    async ({ lootId, count }) => {
      try {
        const result = await disenchantLoot(ctx, { lootId, count });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Disenchant failed: ${err.message}` }]
        };
      }
    }
  );
}
