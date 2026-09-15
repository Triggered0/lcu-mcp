/**
 * Runes / perks configuration workflow engine.
 *
 * Discovers existing rune pages, updates the page this macro owns,
 * or creates and activates a new page.
 */

/**
 * Configures and activates a rune page.
 *
 * @param {object} lcu - Connected LCU client instance
 * @param {object} options
 * @param {string} [options.name='Antigravity Runes'] - Name for the rune page
 * @param {number} options.primaryStyleId - Primary perk style / tree ID
 * @param {number} options.subStyleId - Secondary perk style / tree ID
 * @param {number[]} options.selectedPerkIds - Array of selected perk / rune IDs
 * @param {boolean} [options.replace=true] - Whether to reuse an existing page of the same name
 * @returns {Promise<{
 *   success: boolean,
 *   pageId: number,
 *   name: string,
 *   primaryStyleId: number,
 *   subStyleId: number,
 *   selectedPerkIds: number[],
 *   message: string
 * }>}
 */
export async function setRunePage(
  lcu,
  {
    name = 'Antigravity Runes',
    primaryStyleId,
    subStyleId,
    selectedPerkIds = [],
    replace = true
  } = {}
) {
  if (!lcu || typeof lcu.get !== 'function' || typeof lcu.request !== 'function') {
    throw new Error('LCU client is required');
  }

  if (primaryStyleId === undefined || typeof primaryStyleId !== 'number' || isNaN(primaryStyleId)) {
    throw new Error('primaryStyleId is required and must be a number');
  }

  if (subStyleId === undefined || typeof subStyleId !== 'number' || isNaN(subStyleId)) {
    throw new Error('subStyleId is required and must be a number');
  }

  if (!Array.isArray(selectedPerkIds) || selectedPerkIds.length === 0) {
    throw new Error('selectedPerkIds is required and must be a non-empty array');
  }

  const pagesRes = await lcu.get('/lol-perks/v1/pages');

  if (!pagesRes || (pagesRes.status && pagesRes.status >= 400) || !Array.isArray(pagesRes.body)) {
    throw new Error(`Failed to fetch rune pages: HTTP ${pagesRes?.status}`);
  }

  const pages = pagesRes.body;
  const targetName = name || 'Antigravity Runes';

  if (replace) {
    // Only ever overwrite the page this macro owns. Matching on name keeps
    // repeated calls idempotent without clobbering a page the user built by
    // hand — reusing "whatever is editable" silently destroyed saved runes.
    const ownPage = pages.find((p) => p.isEditable && p.name === targetName);
    if (ownPage) {
      const putPayload = {
        name: targetName,
        primaryStyleId,
        subStyleId,
        selectedPerkIds,
        current: true
      };

      const putRes = await lcu.request('PUT', `/lol-perks/v1/pages/${ownPage.id}`, putPayload);
      if (putRes && putRes.status && putRes.status >= 400) {
        throw new Error(`Failed to update rune page: HTTP ${putRes.status}`);
      }

      return {
        success: true,
        pageId: ownPage.id,
        name: targetName,
        primaryStyleId,
        subStyleId,
        selectedPerkIds,
        message: 'Rune page active'
      };
    }
  }

  // No page of ours to reuse (or the caller asked for a fresh one): create it.
  const postPayload = {
    name: targetName,
    primaryStyleId,
    subStyleId,
    selectedPerkIds,
    isEditable: true,
    current: true
  };

  const postRes = await lcu.request('POST', '/lol-perks/v1/pages', postPayload);
  if (postRes && postRes.status && postRes.status >= 400) {
    throw new Error(`Failed to create rune page: HTTP ${postRes.status}`);
  }

  return {
    success: true,
    pageId: postRes.body?.id ?? null,
    name: targetName,
    primaryStyleId,
    subStyleId,
    selectedPerkIds,
    message: 'Rune page active'
  };
}
