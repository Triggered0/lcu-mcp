export async function getPlayerAnalytics(lcu, staticData, { puuid, matchCount = 10 } = {}) {
  let targetPuuid = puuid;
  let summonerInfo = null;

  if (!targetPuuid) {
    const meRes = await lcu.get('/lol-summoner/v1/current-summoner');
    if (meRes.status !== 200) {
      throw new Error(`Failed to resolve current summoner (HTTP ${meRes.status})`);
    }
    summonerInfo = JSON.parse(meRes.body);
    targetPuuid = summonerInfo.puuid;
  } else {
    const sumRes = await lcu.get(`/lol-summoner/v2/summoners/puuid/${encodeURIComponent(targetPuuid)}`);
    if (sumRes.status === 200) {
      summonerInfo = JSON.parse(sumRes.body);
    }
  }

  const [rankedRes, matchRes, champCatalog] = await Promise.all([
    lcu.get(`/lol-ranked/v1/ranked-stats/${encodeURIComponent(targetPuuid)}`),
    lcu.get(`/lol-match-history/v1/products/lol/${encodeURIComponent(targetPuuid)}/matches?begIndex=0&endIndex=${Math.min(matchCount, 20)}`),
    staticData.load('champions').catch(() => [])
  ]);

  const champMap = new Map((champCatalog || []).map((c) => [c.id, c.name]));

  let soloQueue = { tier: 'UNRANKED', division: '', leaguePoints: 0, wins: 0, losses: 0, winratePercent: 0 };
  let flexQueue = { tier: 'UNRANKED', division: '', leaguePoints: 0, wins: 0, losses: 0, winratePercent: 0 };

  if (rankedRes.status === 200) {
    const rankedData = JSON.parse(rankedRes.body);
    for (const q of rankedData.queues || []) {
      const total = (q.wins || 0) + (q.losses || 0);
      const wr = total > 0 ? Math.round(((q.wins || 0) / total) * 100) : 0;
      const parsed = {
        tier: q.tier || 'UNRANKED',
        division: q.division || '',
        leaguePoints: q.leaguePoints || 0,
        wins: q.wins || 0,
        losses: q.losses || 0,
        winratePercent: wr
      };
      if (q.queueType === 'RANKED_SOLO_5x5') soloQueue = parsed;
      if (q.queueType === 'RANKED_FLEX_SR') flexQueue = parsed;
    }
  }

  let gamesList = [];
  if (matchRes.status === 200) {
    const mData = JSON.parse(matchRes.body);
    gamesList = (mData.games && mData.games.games) || [];
  }

  let totalKills = 0;
  let totalDeaths = 0;
  let totalAssists = 0;
  let totalCs = 0;
  let totalSeconds = 0;
  let winsCount = 0;
  const champStats = new Map();

  for (const game of gamesList) {
    const duration = game.gameDuration || 1;
    totalSeconds += duration;
    const participant = (game.participants && game.participants[0]) || { stats: {} };
    const stats = participant.stats || {};
    const win = Boolean(stats.win);
    if (win) winsCount++;

    const k = stats.kills || 0;
    const d = stats.deaths || 0;
    const a = stats.assists || 0;
    const cs = (stats.totalMinionsKilled || 0) + (stats.neutralMinionsKilled || 0);

    totalKills += k;
    totalDeaths += d;
    totalAssists += a;
    totalCs += cs;

    const champId = participant.championId;
    if (champId) {
      const existing = champStats.get(champId) || { games: 0, wins: 0, kills: 0, deaths: 0, assists: 0 };
      existing.games++;
      if (win) existing.wins++;
      existing.kills += k;
      existing.deaths += d;
      existing.assists += a;
      champStats.set(champId, existing);
    }
  }

  const sampleGames = gamesList.length;
  const winratePercent = sampleGames > 0 ? Math.round((winsCount / sampleGames) * 100) : 0;
  const averageKda = totalDeaths === 0 ? ((totalKills + totalAssists)).toFixed(2) : ((totalKills + totalAssists) / totalDeaths).toFixed(2);
  const averageCsPerMin = totalSeconds > 0 ? ((totalCs / (totalSeconds / 60))).toFixed(1) : '0.0';

  const championPool = Array.from(champStats.entries())
    .map(([id, s]) => ({
      championId: id,
      championName: champMap.get(id) || `Champion #${id}`,
      games: s.games,
      winratePercent: Math.round((s.wins / s.games) * 100),
      kda: s.deaths === 0 ? (s.kills + s.assists).toFixed(2) : ((s.kills + s.assists) / s.deaths).toFixed(2)
    }))
    .sort((a, b) => b.games - a.games)
    .slice(0, 5);

  return {
    summoner: summonerInfo ? {
      puuid: summonerInfo.puuid,
      gameName: summonerInfo.gameName,
      tagLine: summonerInfo.tagLine,
      summonerLevel: summonerInfo.summonerLevel
    } : { puuid: targetPuuid },
    ranked: { soloQueue, flexQueue },
    recentPerformance: {
      evaluatedGames: sampleGames,
      winratePercent,
      averageKda,
      averageCsPerMin,
      totalKills,
      totalDeaths,
      totalAssists
    },
    championPool
  };
}
