import { checkWrite } from '../allowlist.js';

export async function swapBenchChampion(ctx, { champion }) {
  const sessionRes = await ctx.lcu.get('/lol-champ-select/v1/session');
  if (sessionRes.status !== 200) {
    throw new Error('Not currently in an active champion select session.');
  }

  const session = JSON.parse(sessionRes.body);
  const bench = session.benchChampions || [];
  if (bench.length === 0) {
    throw new Error('ARAM bench has no available champions to swap.');
  }

  const champCatalog = await ctx.staticData.load('champions').catch(() => []);
  const champMap = new Map();
  for (const c of champCatalog || []) {
    champMap.set(c.id, c.id);
    if (c.name) champMap.set(c.name.toLowerCase(), c.id);
  }

  let targetId;
  if (typeof champion === 'number') {
    targetId = champion;
  } else {
    const needle = String(champion).trim().toLowerCase();
    targetId = champMap.get(needle);
    if (targetId === undefined) {
      const num = Number(needle);
      if (!Number.isNaN(num)) targetId = num;
    }
  }

  if (!targetId) {
    throw new Error(`Could not resolve champion: "${champion}"`);
  }

  const onBench = bench.some((b) => b.championId === targetId);
  if (!onBench) {
    throw new Error(`Champion #${targetId} is not currently present on the bench.`);
  }

  const path = `/lol-champ-select/v1/session/bench/swap/${targetId}`;
  const allowCheck = checkWrite('POST', path, ctx.config.writeAllowlist);
  if (!allowCheck.allowed) {
    throw new Error(allowCheck.message);
  }

  const res = await ctx.lcu.request('POST', path, '');
  if (res.status >= 400) {
    throw new Error(`Bench swap failed (HTTP ${res.status}): ${res.body}`);
  }

  return {
    success: true,
    swappedChampionId: targetId
  };
}
