import { checkWrite } from '../allowlist.js';

export async function setSummonerSpells(ctx, { spell1, spell2 }) {
  const allowCheck = checkWrite('PATCH', '/lol-champ-select/v1/session/my-selection', ctx.config.writeAllowlist);
  if (!allowCheck.allowed) {
    throw new Error(allowCheck.message);
  }

  const sessionRes = await ctx.lcu.get('/lol-champ-select/v1/session');
  if (sessionRes.status !== 200) {
    throw new Error('Not currently in an active champion select session.');
  }

  const spellsCatalog = await ctx.staticData.load('summoner-spells').catch(() => []);
  const spellMap = new Map();
  for (const s of spellsCatalog || []) {
    spellMap.set(s.id, s.id);
    if (s.name) spellMap.set(s.name.toLowerCase(), s.id);
  }

  function resolveSpell(val) {
    if (typeof val === 'number') return val;
    const needle = String(val).trim().toLowerCase();
    const id = spellMap.get(needle);
    if (id !== undefined) return id;
    const num = Number(needle);
    if (!Number.isNaN(num)) return num;
    throw new Error(`Unknown summoner spell: "${val}"`);
  }

  const payload = {};
  if (spell1 !== undefined) payload.spell1Id = resolveSpell(spell1);
  if (spell2 !== undefined) payload.spell2Id = resolveSpell(spell2);

  const res = await ctx.lcu.request('PATCH', '/lol-champ-select/v1/session/my-selection', JSON.stringify(payload));
  if (res.status >= 400) {
    throw new Error(`Failed to update spells (HTTP ${res.status}): ${res.body}`);
  }

  return {
    success: true,
    updated: payload
  };
}
