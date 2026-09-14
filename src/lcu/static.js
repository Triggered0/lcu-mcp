// The client serves these locally, so id-to-name resolution needs no CDN and no
// Riot API key. Sizes measured live: items.json is 667 KB, the six together are
// about 1.2 MB — hence the per-kind cache below.
const DOCUMENTS = {
  champions: '/lol-game-data/assets/v1/champion-summary.json',
  items: '/lol-game-data/assets/v1/items.json',
  perks: '/lol-game-data/assets/v1/perks.json',
  summonerSpells: '/lol-game-data/assets/v1/summoner-spells.json',
  maps: '/lol-game-data/assets/v1/maps.json',
  queues: '/lol-game-data/assets/v1/queues.json'
};

export const STATIC_KINDS = Object.freeze(Object.keys(DOCUMENTS));

export class LcuStaticService {
  #docs = new Map();

  constructor({ client } = {}) {
    this.client = client;
  }

  async load(kind, { refresh = false } = {}) {
    const path = DOCUMENTS[kind];
    if (!path) {
      throw new Error(`Unknown static data kind: ${kind}`);
    }

    if (!refresh && this.#docs.has(kind)) {
      return this.#docs.get(kind);
    }

    if (!this.client || typeof this.client.get !== 'function') {
      throw new Error('LCU client is required to fetch static data');
    }

    const response = await this.client.get(path);
    if (response?.status && response.status >= 400) {
      throw new Error(`LCU request GET ${path} failed: HTTP ${response.status}`);
    }

    let data = response?.body !== undefined ? response.body : response;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        // Fall through to the array check, which reports the real problem.
      }
    }

    if (!Array.isArray(data)) {
      throw new Error(`LCU request GET ${path} did not return a JSON array`);
    }

    this.#docs.set(kind, data);
    return data;
  }
}
