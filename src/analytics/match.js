export async function getMatchDetailAnalytics(lcu, staticData, { gameId } = {}) {
  let targetGameId = gameId;

  if (!targetGameId) {
    const histRes = await lcu.get('/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=1');
    if (histRes.status === 200) {
      const parsed = JSON.parse(histRes.body);
      const firstGame = (parsed.games && parsed.games.games && parsed.games.games[0]);
      if (firstGame) targetGameId = firstGame.gameId;
    }
  }

  if (!targetGameId) {
    throw new Error('No gameId provided and could not resolve most recent match.');
  }

  const [gameRes, champCatalog] = await Promise.all([
    lcu.get(`/lol-match-history/v1/games/${encodeURIComponent(targetGameId)}`),
    staticData.load('champions').catch(() => [])
  ]);

  if (gameRes.status !== 200) {
    throw new Error(`Failed to load game ${targetGameId}: HTTP ${gameRes.status}`);
  }

  const champMap = new Map((champCatalog || []).map((c) => [c.id, c.name]));
  const game = JSON.parse(gameRes.body);

  const durationMin = ((game.gameDuration || 1) / 60).toFixed(1);
  const teams = game.teams || [];
  const blueTeam = teams.find((t) => t.teamId === 100) || {};
  const redTeam = teams.find((t) => t.teamId === 200) || {};
  const winningTeamId = blueTeam.win === 'Win' ? 100 : (redTeam.win === 'Win' ? 200 : null);

  const identMap = new Map();
  for (const ident of game.participantIdentities || []) {
    identMap.set(ident.participantId, (ident.player && (ident.player.gameName || ident.player.summonerName)) || `Player ${ident.participantId}`);
  }

  let blueTotalDamage = 0;
  let redTotalDamage = 0;
  let blueTotalGold = 0;
  let redTotalGold = 0;
  let blueKills = 0;
  let redKills = 0;

  for (const p of game.participants || []) {
    const dmg = (p.stats && p.stats.totalDamageDealtToChampions) || 0;
    const gold = (p.stats && p.stats.goldEarned) || 0;
    const kills = (p.stats && p.stats.kills) || 0;
    if (p.teamId === 100) {
      blueTotalDamage += dmg;
      blueTotalGold += gold;
      blueKills += kills;
    } else {
      redTotalDamage += dmg;
      redTotalGold += gold;
      redKills += kills;
    }
  }

  const players = (game.participants || []).map((p) => {
    const stats = p.stats || {};
    const dmg = stats.totalDamageDealtToChampions || 0;
    const gold = stats.goldEarned || 0;
    const teamDamageTotal = p.teamId === 100 ? blueTotalDamage : redTotalDamage;
    const teamGoldTotal = p.teamId === 100 ? blueTotalGold : redTotalGold;
    const teamKillsTotal = p.teamId === 100 ? blueKills : redKills;

    const dmgShare = teamDamageTotal > 0 ? Math.round((dmg / teamDamageTotal) * 100) : 0;
    const goldShare = teamGoldTotal > 0 ? Math.round((gold / teamGoldTotal) * 100) : 0;
    const kpPercent = teamKillsTotal > 0 ? Math.round((((stats.kills || 0) + (stats.assists || 0)) / teamKillsTotal) * 100) : 0;

    return {
      participantId: p.participantId,
      teamId: p.teamId,
      summonerName: identMap.get(p.participantId),
      championId: p.championId,
      championName: champMap.get(p.championId) || `Champion #${p.championId}`,
      kda: `${stats.kills || 0}/${stats.deaths || 0}/${stats.assists || 0}`,
      damageDealt: dmg,
      damageSharePercent: dmgShare,
      goldEarned: gold,
      goldSharePercent: goldShare,
      killParticipationPercent: kpPercent,
      visionScore: stats.visionScore || 0
    };
  });

  return {
    summary: {
      gameId: game.gameId,
      gameMode: game.gameMode,
      durationMinutes: durationMin,
      winningTeam: winningTeamId
    },
    objectives: {
      blueTeam: {
        dragons: blueTeam.dragonKills || 0,
        barons: blueTeam.baronKills || 0,
        towers: blueTeam.towerKills || 0
      },
      redTeam: {
        dragons: redTeam.dragonKills || 0,
        barons: redTeam.baronKills || 0,
        towers: redTeam.towerKills || 0
      }
    },
    teamTotals: {
      blue: { damage: blueTotalDamage, gold: blueTotalGold, kills: blueKills },
      red: { damage: redTotalDamage, gold: redTotalGold, kills: redKills }
    },
    players
  };
}
