import { checkWrite } from '../allowlist.js';

export async function inviteToLobby(ctx, { toSummonerPuuids = [] }) {
  const allowCheck = checkWrite('POST', '/lol-lobby/v2/lobby/invitations', ctx.config.writeAllowlist);
  if (!allowCheck.allowed) {
    throw new Error(allowCheck.message);
  }

  const lobbyRes = await ctx.lcu.get('/lol-lobby/v2/lobby');
  if (lobbyRes.status !== 200) {
    throw new Error('Not currently inside a lobby.');
  }

  if (toSummonerPuuids.length === 0) {
    throw new Error('No summoner PUUIDs provided for lobby invitation.');
  }

  const payload = toSummonerPuuids.map((puuid) => ({ toSummonerPuuid: puuid }));
  const res = await ctx.lcu.request('POST', '/lol-lobby/v2/lobby/invitations', JSON.stringify(payload));
  if (res.status >= 400) {
    throw new Error(`Invitation dispatch failed (HTTP ${res.status}): ${res.body}`);
  }

  return {
    success: true,
    invitedPuuids: toSummonerPuuids
  };
}
