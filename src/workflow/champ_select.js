/**
 * Champion select workflow engine.
 *
 * Resolves champions by ID or name, finds eligible local player actions,
 * and executes pick/ban or hover mutations.
 */

/**
 * Executes a pick or ban action in an active champion select session.
 *
 * @param {object} lcu - Connected LCU client instance
 * @param {object} staticData - Static data service instance
 * @param {object} options
 * @param {string|number} options.champion - Champion ID or name
 * @param {'pick'|'ban'} [options.type='pick'] - Action type ('pick' or 'ban')
 * @param {boolean} [options.completed=true] - Whether to lock in (true) or hover (false)
 * @returns {Promise<{
 *   success: boolean,
 *   inChampSelect: boolean,
 *   actionId?: number,
 *   type?: string,
 *   championId?: number,
 *   championName?: string,
 *   completed?: boolean,
 *   message: string
 * }>}
 */
export async function pickOrBanChampion(lcu, staticData, { champion, type = 'pick', completed = true } = {}) {
  if (!lcu || typeof lcu.get !== 'function' || typeof lcu.request !== 'function') {
    throw new Error('LCU client is required');
  }

  if (champion === undefined || champion === null || String(champion).trim() === '') {
    throw new Error('champion is required');
  }

  if (type !== 'pick' && type !== 'ban') {
    throw new Error("type must be 'pick' or 'ban'");
  }

  let championId;
  let championName = null;

  const isNumeric = typeof champion === 'number' || (typeof champion === 'string' && /^\d+$/.test(champion.trim()));

  if (isNumeric) {
    championId = Number(champion);
    if (staticData) {
      try {
        const list = typeof staticData.load === 'function'
          ? await staticData.load('champions')
          : (await staticData.query?.({ kind: 'champions' }))?.entries || [];
        const found = list.find((c) => c.id === championId);
        if (found) championName = found.name;
      } catch {
        // Non-fatal if static name lookup fails for numeric ID
      }
    }
  } else {
    if (!staticData || (typeof staticData.load !== 'function' && typeof staticData.query !== 'function')) {
      throw new Error('Static data service required to resolve champion name');
    }

    let list = [];
    if (typeof staticData.load === 'function') {
      list = await staticData.load('champions');
    } else if (typeof staticData.query === 'function') {
      const q = await staticData.query({ kind: 'champions', query: String(champion) });
      list = q.entries || [];
    }

    const needle = String(champion).trim().toLowerCase();
    let match = list.find((c) => String(c.name).toLowerCase() === needle);

    if (!match) {
      const partial = list.filter((c) => String(c.name).toLowerCase().includes(needle));
      // A lock-in cannot be undone, so an ambiguous prefix must not silently
      // resolve to whichever champion happens to come first in the catalog.
      if (partial.length > 1) {
        throw new Error(
          `Champion "${champion}" is ambiguous, matches: ${partial.map((c) => c.name).join(', ')}`
        );
      }
      match = partial[0];
    }

    if (!match) {
      throw new Error(`Champion not found: ${champion}`);
    }

    championId = match.id;
    championName = match.name;
  }

  // A closed client throws instead of answering 404, and "the client is down" is
  // a different diagnosis from "not in champ select" — let that error propagate.
  const sessionRes = await lcu.get('/lol-champ-select/v1/session');

  if (!sessionRes || (sessionRes.status && sessionRes.status >= 400) || !sessionRes.body) {
    return {
      success: false,
      inChampSelect: false,
      message: 'Not currently in champion select'
    };
  }

  const session = sessionRes.body;
  const localPlayerCellId = session.localPlayerCellId;
  const rawActions = Array.isArray(session.actions) ? session.actions.flat() : [];

  const candidateActions = rawActions.filter(
    (a) => a.actorCellId === localPlayerCellId && a.type === type && !a.completed
  );

  if (candidateActions.length === 0) {
    return {
      success: false,
      inChampSelect: true,
      message: `No active ${type} action found for local player`
    };
  }

  const action = candidateActions.find((a) => a.isInProgress) || candidateActions[0];

  const patchRes = await lcu.request(
    'PATCH',
    `/lol-champ-select/v1/session/actions/${action.id}`,
    { championId, completed }
  );

  if (patchRes && patchRes.status && patchRes.status >= 400) {
    throw new Error(`Failed to execute ${type} action: HTTP ${patchRes.status}`);
  }

  const actionVerb = completed ? 'Locked in' : 'Hovered';
  const nameDisplay = championName || championId;

  return {
    success: true,
    inChampSelect: true,
    actionId: action.id,
    type,
    championId,
    championName: championName ?? undefined,
    completed,
    message: `${actionVerb} ${nameDisplay}`
  };
}
