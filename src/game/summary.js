/**
 * Pure projection utility for Live Client Data API.
 * Transforms raw 50-100 KB /liveclientdata/allgamedata payloads into compact,
 * token-efficient summaries suitable for LLM consumption.
 */

/**
 * Projects raw allgamedata into a compact match overview.
 *
 * @param {object} [raw={}] - Raw response payload from /liveclientdata/allgamedata
 * @returns {{
 *   game: { mode: string, gameTime: number, timeMinutes: number, mapName: string, mapTerrain: string },
 *   activePlayer: { summonerName: string, championName: string, level: number, currentGold: number, health: string, resource: string, attackDamage: number, abilityPower: number, kda: string, creepScore: number },
 *   teams: { ORDER: { kills: number, deaths: number, assists: number, players: Array<object> }, CHAOS: { kills: number, deaths: number, assists: number, players: Array<object> } },
 *   latestEvents: Array<{ id: number, name: string, time: number, killer: string|undefined, victim: string|undefined }>
 * }}
 */
export function summarizeGameData(raw = {}) {
  const payload = raw && typeof raw === 'object' ? raw : {};
  const gameData = payload.gameData || {};
  const activePlayer = payload.activePlayer || {};
  const allPlayers = Array.isArray(payload.allPlayers) ? payload.allPlayers : [];
  const eventsList = payload.events && Array.isArray(payload.events.Events) ? payload.events.Events : [];

  const gameTime = typeof gameData.gameTime === 'number' ? gameData.gameTime : 0;
  const timeMinutes = Number((gameTime / 60).toFixed(1));

  const game = {
    mode: gameData.gameMode ?? 'UNKNOWN',
    gameTime,
    timeMinutes,
    mapName: gameData.mapName ?? 'UNKNOWN',
    mapTerrain: gameData.mapTerrain ?? 'Default'
  };

  const activeStats = activePlayer.championStats || {};
  const activeScores = activePlayer.scores || {};
  const active = {
    summonerName: activePlayer.summonerName ?? activePlayer.riotId ?? 'Unknown',
    championName: activePlayer.championName ?? 'Unknown',
    level: activePlayer.level ?? 1,
    currentGold: activePlayer.currentGold ?? 0,
    health: `${Math.round(activeStats.currentHealth ?? 0)}/${Math.round(activeStats.maxHealth ?? 0)}`,
    resource: `${Math.round(activeStats.resourceValue ?? 0)}/${Math.round(activeStats.resourceMax ?? 0)}`,
    attackDamage: Math.round(activeStats.attackDamage ?? 0),
    abilityPower: Math.round(activeStats.abilityPower ?? 0),
    kda: `${activeScores.kills ?? 0}/${activeScores.deaths ?? 0}/${activeScores.assists ?? 0}`,
    creepScore: activeScores.creepScore ?? 0
  };

  const teams = {
    ORDER: { kills: 0, deaths: 0, assists: 0, players: [] },
    CHAOS: { kills: 0, deaths: 0, assists: 0, players: [] }
  };

  for (const p of allPlayers) {
    if (!p || typeof p !== 'object') continue;
    const teamStr = String(p.team ?? '').toUpperCase();
    const teamKey = teamStr === 'CHAOS' || teamStr === '200' ? 'CHAOS' : 'ORDER';
    const scores = p.scores || {};
    const kills = scores.kills ?? 0;
    const deaths = scores.deaths ?? 0;
    const assists = scores.assists ?? 0;

    teams[teamKey].kills += kills;
    teams[teamKey].deaths += deaths;
    teams[teamKey].assists += assists;

    const items = Array.isArray(p.items)
      ? p.items
          .filter((it) => it && typeof it === 'object')
          .map((it) => it.displayName || it.name || (it.itemID != null ? `Item ${it.itemID}` : null))
          .filter(Boolean)
      : [];

    teams[teamKey].players.push({
      summonerName: p.summonerName ?? p.riotId ?? 'Unknown',
      championName: p.championName ?? 'Unknown',
      level: p.level ?? 1,
      kda: `${kills}/${deaths}/${assists}`,
      creepScore: scores.creepScore ?? 0,
      items
    });
  }

  const latestEvents = eventsList
    .filter((e) => e && typeof e === 'object')
    .slice(-5)
    .map((e) => ({
      id: e.EventID,
      name: e.EventName,
      time: typeof e.EventTime === 'number' ? Number(e.EventTime.toFixed(1)) : e.EventTime,
      killer: e.KillerName,
      victim: e.VictimName ?? e.Recipient
    }));

  return {
    game,
    activePlayer: active,
    teams,
    latestEvents
  };
}
