export async function getLiveCombatAnalytics(gameClient) {
  const isRunning = await gameClient.isGameRunning().catch(() => false);
  if (!isRunning) {
    return {
      inGame: false,
      message: 'League of Legends game engine is not running on port 2999.'
    };
  }

  const raw = await gameClient.getAllGameData().catch((err) => {
    throw new Error(`Failed to read Live Game Data: ${err.message}`);
  });

  const timeSec = Math.floor((raw.gameData && raw.gameData.gameTime) || 0);
  const clock = `${Math.floor(timeSec / 60)}m ${timeSec % 60}s`;

  let orderKills = 0;
  let chaosKills = 0;
  let orderCs = 0;
  let chaosCs = 0;

  const players = (raw.allPlayers || []).map((p) => {
    const s = p.scores || {};
    const k = s.kills || 0;
    const cs = s.creepScore || 0;
    if (p.team === 'ORDER') {
      orderKills += k;
      orderCs += cs;
    } else {
      chaosKills += k;
      chaosCs += cs;
    }
    return {
      summonerName: p.summonerName,
      championName: p.championName,
      team: p.team,
      level: p.level,
      kda: `${k}/${s.deaths || 0}/${s.assists || 0}`,
      creepScore: cs
    };
  });

  return {
    inGame: true,
    gameClock: clock,
    gameMode: (raw.gameData && raw.gameData.gameMode) || 'UNKNOWN',
    teams: {
      order: { totalKills: orderKills, totalCs: orderCs },
      chaos: { totalKills: chaosKills, totalCs: chaosCs }
    },
    players
  };
}
