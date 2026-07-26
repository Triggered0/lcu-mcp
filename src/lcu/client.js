import { readFileSync } from 'node:fs';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { DEFAULT_LOCKFILE_PATH, readCredentials, watchLockfileDir } from './lockfile.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CA_PATH = resolve(HERE, '../../certs/riotgames.pem');

export function buildAuthHeader(password) {
  return `Basic ${Buffer.from(`riot:${password}`).toString('base64')}`;
}

export function buildRequestOptions({ creds, method, path, body, ca }) {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new Error(`LCU path must start with "/", got ${JSON.stringify(path)}`);
  }
  const headers = {
    Authorization: buildAuthHeader(creds.password),
    Accept: 'application/json'
  };
  let payload;
  if (body !== undefined && body !== null) {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  return {
    options: { hostname: '127.0.0.1', port: creds.port, method: String(method).toUpperCase(), path, headers, ca },
    payload
  };
}

export class LcuClient {
  #creds = null;
  #lastError = null;
  #stopWatch = null;

  constructor({ lockfilePath = DEFAULT_LOCKFILE_PATH, caPath = DEFAULT_CA_PATH } = {}) {
    this.lockfilePath = lockfilePath;
    this.ca = readFileSync(caPath);
    this.agent = new https.Agent({ ca: this.ca, keepAlive: true });
  }

  async credentials() {
    if (this.#creds) return this.#creds;
    this.#stopWatch ??= watchLockfileDir(this.lockfilePath, () => this.invalidate());
    try {
      this.#creds = await readCredentials(this.lockfilePath);
      this.#lastError = null;
    } catch (err) {
      this.#lastError = err.message;
      throw err;
    }
    return this.#creds;
  }

  currentPassword() {
    return this.#creds?.password ?? null;
  }

  invalidate() {
    this.#creds = null;
  }

  async request(method, path, body, { retry = true } = {}) {
    const creds = await this.credentials();
    try {
      return await this.#send(creds, method, path, body);
    } catch (err) {
      // A stale port survives in the cache when the client restarts between calls.
      if (retry && (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET')) {
        this.invalidate();
        return this.request(method, path, body, { retry: false });
      }
      this.#lastError = err.message;
      throw new Error(`LCU request ${String(method).toUpperCase()} ${path} failed: ${err.message}`);
    }
  }

  get(path) {
    return this.request('GET', path);
  }

  #send(creds, method, path, body) {
    const { options, payload } = buildRequestOptions({ creds, method, path, body, ca: this.ca });
    return new Promise((resolvePromise, reject) => {
      const req = https.request({ ...options, agent: this.agent }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = text;
          if (text.length > 0) {
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = text;
            }
          }
          resolvePromise({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  statusSnapshot() {
    return {
      connected: this.#creds !== null,
      port: this.#creds?.port ?? null,
      lockfilePath: this.lockfilePath,
      lastError: this.#lastError
    };
  }

  close() {
    this.#stopWatch?.();
    this.#stopWatch = null;
    this.agent.destroy();
  }
}
