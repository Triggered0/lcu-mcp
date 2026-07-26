import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const DEFAULTS = {
  allowEval: true,
  cdpPort: 8888,
  eventBufferSize: 1000,
  writeAllowlist: []
};

export function validateConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Config must be a JSON object');
  }
  const config = { ...DEFAULTS, ...raw };
  if (typeof config.allowEval !== 'boolean') {
    throw new Error(`Config "allowEval" must be a boolean, got ${typeof config.allowEval}`);
  }
  if (!Number.isInteger(config.cdpPort) || config.cdpPort < 1 || config.cdpPort > 65535) {
    throw new Error(`Config "cdpPort" must be an integer port, got ${JSON.stringify(config.cdpPort)}`);
  }
  if (!Number.isInteger(config.eventBufferSize) || config.eventBufferSize < 1) {
    throw new Error(`Config "eventBufferSize" must be a positive integer, got ${JSON.stringify(config.eventBufferSize)}`);
  }
  if (!Array.isArray(config.writeAllowlist) || config.writeAllowlist.some((e) => typeof e !== 'string')) {
    throw new Error('Config "writeAllowlist" must be an array of "METHOD /path" strings');
  }
  return config;
}

export function loadConfig({ env = process.env, cwd = process.cwd() } = {}) {
  const configPath = env.LCU_MCP_CONFIG ?? resolve(cwd, 'config/allowlist.json');
  let text;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { ...DEFAULTS, configPath };
    throw new Error(`Cannot read config at ${configPath}: ${err.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`Config at ${configPath} is not valid JSON: ${err.message}`);
  }
  return { ...validateConfig(raw), configPath };
}
