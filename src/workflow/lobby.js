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
  if (!lcu || typeof lcu.get !== 'function' || typeof lcu.request !== 'function') {
    throw new Error('LCU client is required');
  }

  if (queueId === undefined || typeof queueId !== 'number' || isNaN(queueId)) {
    throw new Error('queueId is required and must be a number');
  }

  // The client answers 404 when there is no lobby; only a dead client throws,
  // and that is worth surfacing rather than treating as "no lobby".
  const res = await lcu.get('/lol-lobby/v2/lobby');
  const currentLobby = res && res.status === 200 && res.body ? res.body : null;

  const hadPriorLobby = currentLobby !== null;
  const alreadyInSameQueue = currentLobby?.gameConfig?.queueId === queueId;
  let createdLobby = false;
  let message = 'Lobby created';

  if (alreadyInSameQueue) {
    message = 'Already in lobby';
  } else {
    const postRes = await lcu.request('POST', '/lol-lobby/v2/lobby', { queueId });
    if (postRes && postRes.status && postRes.status >= 400) {
      throw new Error(`Failed to create lobby: HTTP ${postRes.status}`);
    }
    createdLobby = true;
  }

  if (startMatchmaking) {
    const searchRes = await lcu.request('POST', '/lol-lobby/v2/lobby/matchmaking/search');
    if (searchRes && searchRes.status && searchRes.status >= 400) {
      const outcome = await undoLobby(lcu, { createdLobby, hadPriorLobby, queueId });
      throw new Error(`Failed to start matchmaking: HTTP ${searchRes.status}. ${outcome}`);
    }
  }

  return {
    success: true,
    queueId,
    matchmakingStarted: Boolean(startMatchmaking),
    message
  };
}

/**
 * Undoes the lobby this call created, when undoing is an improvement.
 *
 * Only what this call created is in scope. If the new lobby replaced one the
 * caller was already in, that party is gone either way and cannot be rebuilt,
 * so leaving them in the requested lobby beats leaving them in none at all.
 *
 * @returns {Promise<string>} A sentence describing the state the client is left in
 */
async function undoLobby(lcu, { createdLobby, hadPriorLobby, queueId }) {
  if (!createdLobby) {
    return `The client is still in the queue ${queueId} lobby it was already in.`;
  }
  if (hadPriorLobby) {
    return `The queue ${queueId} lobby was kept, because it replaced a lobby that cannot be restored.`;
  }

  // Undoing is itself a write, so it can be refused by the allowlist or fail on
  // its own; either way the caller needs to hear which state they ended up in.
  try {
    const delRes = await lcu.request('DELETE', '/lol-lobby/v2/lobby');
    if (delRes && delRes.status && delRes.status >= 400) {
      return `The queue ${queueId} lobby created by this call is still open: leaving it returned HTTP ${delRes.status}.`;
    }
    return `The queue ${queueId} lobby created by this call was closed again.`;
  } catch (err) {
    return `The queue ${queueId} lobby created by this call is still open: leaving it failed (${err.message}).`;
  }
}
