import { checkWrite } from '../allowlist.js';

export async function triggerPlayAgain(ctx) {
  const allowCheck = checkWrite('POST', '/lol-lobby/v2/play-again', ctx.config.writeAllowlist);
  if (!allowCheck.allowed) {
    throw new Error(allowCheck.message);
  }

  const phaseRes = await ctx.lcu.get('/lol-gameflow/v1/gameflow-phase');
  if (phaseRes.status === 200) {
    const phase = JSON.parse(phaseRes.body);
    if (phase !== 'EndOfGame' && phase !== 'PreEndOfGame') {
      throw new Error(`Cannot play again from phase "${phase}". Must be in EndOfGame.`);
    }
  }

  const res = await ctx.lcu.request('POST', '/lol-lobby/v2/play-again', '');
  if (res.status >= 400) {
    throw new Error(`Play again request failed (HTTP ${res.status}): ${res.body}`);
  }

  return { success: true, message: 'Play again lobby recreated.' };
}

export async function submitHonor(ctx, { target, honorCategory = 'HEART' }) {
  const allowCheck = checkWrite('POST', '/lol-honor/v1/honor', ctx.config.writeAllowlist);
  if (!allowCheck.allowed) {
    throw new Error(allowCheck.message);
  }

  const ballotRes = await ctx.lcu.get('/lol-honor/v1/ballot');
  if (ballotRes.status !== 200) {
    throw new Error('No active honor ballot available.');
  }

  const ballot = JSON.parse(ballotRes.body);
  const eligible = ballot.eligiblePlayers || [];

  let matchedPlayer = null;
  const needle = String(target).trim().toLowerCase();

  for (const p of eligible) {
    if (String(p.summonerId) === needle) {
      matchedPlayer = p;
      break;
    }
    if (p.summonerName && p.summonerName.toLowerCase() === needle) {
      matchedPlayer = p;
      break;
    }
    if (p.gameName && p.gameName.toLowerCase() === needle) {
      matchedPlayer = p;
      break;
    }
  }

  if (!matchedPlayer) {
    throw new Error(`Target player "${target}" not found on honor ballot.`);
  }

  const payload = {
    honorCategory,
    summonerId: matchedPlayer.summonerId
  };

  const res = await ctx.lcu.request('POST', '/lol-honor/v1/honor', JSON.stringify(payload));
  if (res.status >= 400) {
    throw new Error(`Honor submission failed (HTTP ${res.status}): ${res.body}`);
  }

  return {
    success: true,
    honoredSummonerId: matchedPlayer.summonerId,
    honorCategory
  };
}
