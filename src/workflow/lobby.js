/**
 * Lobby creation and matchmaking dispatch workflow engine.
 *
 * Creates lobbies for specific queue IDs and optionally dispatches matchmaking search.
 */

/**
 * Creates a game lobby and optionally initiates matchmaking search.
 *
 * @param {object} lcu - Connected LCU client instance
 * @param {object} options
 * @param {number} options.queueId - Target queue ID (e.g. 420 for Ranked Solo/Duo, 440 for Flex)
 * @param {boolean} [options.startMatchmaking=false] - Whether to immediately start searching
 * @returns {Promise<{
 *   success: boolean,
 *   queueId: number,
 *   matchmakingStarted: boolean,
 *   message: string
 * }>}
 */
export async function createLobby(lcu, { queueId, startMatchmaking = false } = {}) {
  if (!lcu || (typeof lcu.get !== 'function' && typeof lcu.request !== 'function')) {
    throw new Error('LCU client is required');
  }

  if (queueId === undefined || typeof queueId !== 'number' || isNaN(queueId)) {
    throw new Error('queueId is required and must be a number');
  }

  let currentLobby = null;
  try {
    const res = typeof lcu.get === 'function'
      ? await lcu.get('/lol-lobby/v2/lobby')
      : await lcu.request('GET', '/lol-lobby/v2/lobby');
    if (res && res.status === 200 && res.body) {
      currentLobby = res.body;
    }
  } catch {
    // Client may return 404 if not currently in a lobby
  }

  const alreadyInSameQueue = currentLobby?.gameConfig?.queueId === queueId;
  let message = 'Lobby created';

  if (alreadyInSameQueue) {
    message = 'Already in lobby';
  } else {
    const postRes = await lcu.request('POST', '/lol-lobby/v2/lobby', { queueId });
    if (postRes && postRes.status && postRes.status >= 400) {
      throw new Error(`Failed to create lobby: HTTP ${postRes.status}`);
    }
  }

  if (startMatchmaking) {
    const searchRes = await lcu.request('POST', '/lol-lobby/v2/lobby/matchmaking/search');
    if (searchRes && searchRes.status && searchRes.status >= 400) {
      throw new Error(`Failed to start matchmaking: HTTP ${searchRes.status}`);
    }
  }

  return {
    success: true,
    queueId,
    matchmakingStarted: Boolean(startMatchmaking),
    message
  };
}
