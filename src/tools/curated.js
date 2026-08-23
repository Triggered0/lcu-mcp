const table = [
  { method: 'GET', path: '/lol-gameflow/v1/gameflow-phase', group: 'gameflow', description: 'Current phase string (None, Lobby, ReadyCheck, ChampSelect, InProgress, EndOfGame)' },
  { method: 'GET', path: '/lol-gameflow/v1/session', group: 'gameflow', description: 'Full gameflow session including queue and map' },

  { method: 'GET', path: '/lol-champ-select/v1/session', group: 'champ-select', description: 'Champ select session: actions, my team, bans, timer' },
  { method: 'PATCH', path: '/lol-champ-select/v1/session/actions/{id}', group: 'champ-select', description: 'Set or complete a pick/ban action' },
  { method: 'GET', path: '/lol-champ-select/v1/bannable-champion-ids', group: 'champ-select', description: 'Champion ids currently bannable' },
  { method: 'GET', path: '/lol-champ-select/v1/pickable-champion-ids', group: 'champ-select', description: 'Champion ids currently pickable' },

  { method: 'GET', path: '/lol-summoner/v1/current-summoner', group: 'summoner', description: 'Logged-in summoner: puuid, gameName, tagLine, level' },
  { method: 'GET', path: '/lol-summoner/v1/summoners/{id}', group: 'summoner', description: 'Summoner by summonerId' },
  { method: 'GET', path: '/lol-summoner/v2/summoners/puuid/{puuid}', group: 'summoner', description: 'Summoner by puuid' },
  { method: 'GET', path: '/lol-summoner/v1/summoners/aliases', group: 'summoner', description: 'Riot ID aliases for a set of puuids' },
  { method: 'GET', path: '/lol-summoner/v1/alias/lookup', group: 'summoner', description: 'Look up a summoner by Riot ID alias' },

  { method: 'GET', path: '/lol-lobby/v2/lobby', group: 'lobby', description: 'Current lobby: queue, members, invitations' },
  { method: 'POST', path: '/lol-lobby/v2/lobby/matchmaking/search', group: 'lobby', description: 'Start matchmaking search' },
  { method: 'DELETE', path: '/lol-lobby/v2/lobby/matchmaking/search', group: 'lobby', description: 'Stop matchmaking search' },
  { method: 'POST', path: '/lol-lobby/v2/play-again', group: 'lobby', description: 'Recreate the previous lobby' },
  { method: 'GET', path: '/lol-lobby/v2/notifications', group: 'lobby', description: 'Lobby notifications' },
  { method: 'GET', path: '/lol-lobby/v2/lobby/invitations', group: 'lobby', description: 'Pending lobby invitations' },

  { method: 'GET', path: '/lol-matchmaking/v1/ready-check', group: 'matchmaking', description: 'Ready check state and remaining time' },
  { method: 'POST', path: '/lol-matchmaking/v1/ready-check/accept', group: 'matchmaking', description: 'Accept the ready check' },

  { method: 'GET', path: '/lol-end-of-game/v1/eog-stats-block', group: 'end-of-game', description: 'End-of-game stats block' },
  { method: 'GET', path: '/lol-honor/v1/honor', group: 'end-of-game', description: 'Honor state' },
  { method: 'GET', path: '/lol-honor/v1/ballot', group: 'end-of-game', description: 'Current honor ballot' },

  { method: 'GET', path: '/lol-chat/v1/me', group: 'chat', description: 'Own chat presence and availability' },
  { method: 'GET', path: '/lol-chat/v1/friends', group: 'chat', description: 'Friend list with presence' },
  { method: 'GET', path: '/lol-chat/v1/friend-groups', group: 'chat', description: 'Friend group definitions' },
  { method: 'GET', path: '/lol-chat/v1/conversations', group: 'chat', description: 'Open conversations' },

  { method: 'GET', path: '/lol-ranked/v1/ranked-stats/{puuid}', group: 'ranked', description: 'Ranked stats per queue for a puuid' },
  { method: 'GET', path: '/lol-match-history/v1/products/lol/current-summoner/matches', group: 'match-history', description: 'Recent matches for the current summoner' },
  { method: 'GET', path: '/lol-match-history/v1/games/{id}', group: 'match-history', description: 'Full game detail by gameId' },

  { method: 'GET', path: '/lol-challenges/v1/summary-player-data/local-player', group: 'challenges', description: 'Local player challenge summary' },
  { method: 'GET', path: '/lol-settings/v1/local/video', group: 'settings', description: 'Local video settings blob' },
  { method: 'GET', path: '/lol-champions/v1/inventories/{id}/champions-minimal', group: 'inventory', description: 'Owned champions, minimal shape' },
  { method: 'GET', path: '/lol-loot/v1/player-loot', group: 'inventory', description: 'Loot inventory' },
  { method: 'GET', path: '/lol-inventory/v2/inventory/CHAMPION', group: 'inventory', description: 'Inventory by type (CHAMPION, SKIN, WARD_SKIN, ...)' },
  { method: 'GET', path: '/lol-catalog/v1/items/EMOTE', group: 'inventory', description: 'Store catalog for a type' },

  { method: 'GET', path: '/riotclient/region-locale', group: 'riotclient', description: 'Region, locale, and web region' }
];

export const ENDPOINTS = Object.freeze(table.map((entry) => Object.freeze(entry)));
export const GROUPS = Object.freeze([...new Set(ENDPOINTS.map((e) => e.group))]);

export function filterEndpoints(filter) {
  if (typeof filter !== 'string' || filter.trim().length === 0) return ENDPOINTS;
  const needle = filter.trim().toLowerCase();
  return ENDPOINTS.filter((e) =>
    `${e.method} ${e.path} ${e.group} ${e.description}`.toLowerCase().includes(needle)
  );
}
