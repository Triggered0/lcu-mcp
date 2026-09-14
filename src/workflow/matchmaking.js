/**
 * Matchmaking ready check workflow engine.
 *
 * Checks active ready-check state and accepts if active and unaccepted.
 */

/**
 * Accepts an active matchmaking ready check.
 *
 * @param {object} lcu - Connected LCU client instance
 * @returns {Promise<{ success: boolean, state: string, playerResponse: string, message: string }>}
 */
export async function acceptReadyCheck(lcu) {
  if (!lcu || (typeof lcu.get !== 'function' && typeof lcu.request !== 'function')) {
    throw new Error('LCU client is required');
  }

  let res;
  try {
    res = typeof lcu.get === 'function'
      ? await lcu.get('/lol-matchmaking/v1/ready-check')
      : await lcu.request('GET', '/lol-matchmaking/v1/ready-check');
  } catch {
    return {
      success: false,
      state: 'None',
      playerResponse: 'None',
      message: 'Ready check is not currently in progress'
    };
  }

  if (!res || (res.status && res.status >= 400) || !res.body) {
    return {
      success: false,
      state: 'None',
      playerResponse: 'None',
      message: 'Ready check is not currently in progress'
    };
  }

  const state = res.body.state ?? 'None';
  const playerResponse = res.body.playerResponse ?? 'None';

  if (state !== 'InProgress') {
    return {
      success: false,
      state,
      playerResponse,
      message: 'Ready check is not currently in progress'
    };
  }

  if (playerResponse === 'Accepted') {
    return {
      success: true,
      state,
      playerResponse: 'Accepted',
      message: 'Ready check already accepted'
    };
  }

  const postRes = await lcu.request('POST', '/lol-matchmaking/v1/ready-check/accept');
  if (postRes && postRes.status && postRes.status >= 400) {
    throw new Error(`Failed to accept ready check: HTTP ${postRes.status}`);
  }

  return {
    success: true,
    state: 'InProgress',
    playerResponse: 'Accepted',
    message: 'Matchmaking ready check accepted'
  };
}
