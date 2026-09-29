import { checkWrite } from '../allowlist.js';

export async function getLootSummary(lcu) {
  const res = await lcu.get('/lol-loot/v1/player-loot');
  if (res.status !== 200) {
    throw new Error(`Failed to fetch player loot (HTTP ${res.status})`);
  }

  const items = JSON.parse(res.body) || [];
  let championShards = 0;
  let skinShards = 0;
  let totalBE = 0;
  let totalOE = 0;
  const shards = [];

  for (const item of items) {
    const count = item.count || 1;
    const disenchantVal = item.disenchantValue || 0;
    const type = item.type || '';

    if (type.includes('CHAMPION')) {
      championShards += count;
      totalBE += disenchantVal * count;
      shards.push({
        lootId: item.lootId,
        name: item.itemDesc || item.lootId,
        count,
        disenchantValue: disenchantVal,
        currency: 'BLUE_ESSENCE'
      });
    } else if (type.includes('SKIN')) {
      skinShards += count;
      totalOE += disenchantVal * count;
      shards.push({
        lootId: item.lootId,
        name: item.itemDesc || item.lootId,
        count,
        disenchantValue: disenchantVal,
        currency: 'ORANGE_ESSENCE'
      });
    }
  }

  return {
    totalChampionShards: championShards,
    totalSkinShards: skinShards,
    totalPotentialBlueEssence: totalBE,
    totalPotentialOrangeEssence: totalOE,
    shards
  };
}

export async function disenchantLoot(ctx, { lootId, count = 1 }) {
  const path = `/lol-loot/v1/recipes/${encodeURIComponent(lootId)}_disenchant/craft`;
  const allowCheck = checkWrite('POST', path, ctx.config.writeAllowlist);
  if (!allowCheck.allowed) {
    throw new Error(allowCheck.message);
  }

  const res = await ctx.lcu.request('POST', path, JSON.stringify([lootId, count]));
  if (res.status >= 400) {
    throw new Error(`Disenchant failed (HTTP ${res.status}): ${res.body}`);
  }

  return {
    success: true,
    lootId,
    countDisenchanted: count
  };
}
