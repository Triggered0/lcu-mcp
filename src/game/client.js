import https from 'node:https';
import { readFileSync } from 'node:fs';
import { DEFAULT_CA_PATH } from '../lcu/client.js';

export class GameNotRunningError extends Error {
  constructor(message = 'Live game is not currently running. The Live Client Data API is only active during matches.') {
    super(message);
    this.name = 'GameNotRunningError';
  }
}

export class LiveGameClient {
  #port;
  #timeoutMs;
  #agent;

  constructor({ port = 2999, caPath = DEFAULT_CA_PATH, timeoutMs = 2000, agent = null } = {}) {
    this.#port = port;
    this.#timeoutMs = timeoutMs;
    if (agent) {
      this.#agent = agent;
    } else {
      let ca;
      try {
        ca = readFileSync(caPath);
      } catch {
        ca = undefined;
      }
      this.#agent = new https.Agent({
        ca,
        keepAlive: true,
        checkServerIdentity: () => undefined
      });
    }
  }

  get port() {
    return this.#port;
  }

  async isGameRunning() {
    try {
      await this.getGameStats();
      return true;
    } catch {
      return false;
    }
  }

  async request(endpoint, query = {}) {
    const cleanEndpoint = endpoint.replace(/^\/?(liveclientdata\/)?/, '');
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) {
        searchParams.set(key, String(value));
      }
    }
    const qs = searchParams.toString();
    const path = `/liveclientdata/${cleanEndpoint}${qs ? `?${qs}` : ''}`;

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: '127.0.0.1',
          port: this.#port,
          method: 'GET',
          path,
          headers: { Accept: 'application/json' },
          agent: this.#agent,
          timeout: this.#timeoutMs
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('error', (err) => {
            reject(err);
          });
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode && res.statusCode >= 400) {
              return reject(new Error(`Live game API returned HTTP ${res.statusCode}: ${raw}`));
            }
            try {
              const data = JSON.parse(raw);
              resolve(data);
            } catch (err) {
              reject(new Error(`Failed to parse JSON response from ${path}: ${err.message}`));
            }
          });
        }
      );

      req.on('timeout', () => {
        req.destroy(new Error('ETIMEDOUT'));
      });

      req.on('error', (err) => {
        const code = err.code || err.message;
        if (
          code === 'ECONNREFUSED' ||
          code === 'ECONNRESET' ||
          code === 'ETIMEDOUT' ||
          code === 'ENOTFOUND' ||
          code === 'UND_ERR_SOCKET' ||
          /ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|UND_ERR_SOCKET/i.test(err.message)
        ) {
          return reject(new GameNotRunningError());
        }
        reject(err);
      });

      req.end();
    });
  }

  async getGameStats() {
    return this.request('gamestats');
  }

  async getAllGameData() {
    return this.request('allgamedata');
  }

  async getActivePlayer() {
    return this.request('activeplayer');
  }

  async getPlayerList() {
    return this.request('playerlist');
  }

  async getEvents(afterId = null) {
    return this.request('eventdata', afterId !== null && afterId !== undefined ? { afterID: afterId } : {});
  }
}
