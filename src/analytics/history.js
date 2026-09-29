export async function getMatchHistory(lcu, staticData, { puuid, limit = 10, queueId } = {}) {
  let targetPuuid = puuid;
  if (!targetPuuid) {
    const meRes = await lcu.get('/lol-summoner/v1/current-summoner');
    if (meRes.status !== 200) {
      throw new Error(`Failed to resolve summoner: HTTP ${meRes.status}`);
    }
    const me = JSON.parse(meRes.body);
    targetPuuid = me.puuid;
  }

  const boundedLimit = Math.min(Math.max(limit || 10, 1), 20);
  const [matchRes, champCatalog] = await Promise.all([
    lcu.get(`/lol-match-history/v1/products/lol/${encodeURIComponent(targetPuuid)}/matches?begIndex=0&endIndex=${boundedLimit}`),
    staticData.load('champions').catch(() => [])
  ]);

  if (matchRes.status !== 200) {
    throw new Error(`Match history request failed: HTTP ${matchRes.status}`);
  }

  const champMap = new Map((champCatalog || []).map((c) => [c.id, c.name]));
  const parsed = JSON.parse(matchRes.body);
  const rawGames = (parsed.games && parsed.games.games) || [];

  const matches = rawGames
    .filter((g) => (queueId !== undefined ? g.queueId === queueId : true))
    .slice(0, boundedLimit)
    .map((g) => {
      const participant = (g.participants && g.participants[0]) || { stats: {} };
      const stats = participant.stats || {};
      const win = Boolean(stats.win);
      const k = stats.kills || 0;
      const d = stats.deaths || 0;
      const a = stats.assists || 0;
      const cs = (stats.totalMinionsKilled || 0) + (stats.neutralMinionsKilled || 0);
      const minutes = Math.floor((g.gameDuration || 0) / 60);
      const seconds = (g.gameDuration || 0) % 60;

      return {
        gameId: g.gameId,
        date: g.gameCreationDate,
        duration: `${minutes}m ${seconds}s`,
        queueId: g.queueId,
        championId: participant.championId,
        championName: champMap.get(participant.championId) || `Champion #${participant.championId}`,
        result: win ? 'WIN' : 'LOSS',
        kda: `${k}/${d}/${a}`,
        kdaRatio: d === 0 ? (k + a).toFixed(2) : ((k + a) / d).toFixed(2),
        cs
      };
    });

  return {
    puuid: targetPuuid,
    totalMatches: matches.length,
    matches
  };
}
