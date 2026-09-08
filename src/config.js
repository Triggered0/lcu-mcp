import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const DEFAULTS = {
  allowEval: true,
  cdpPort: 'auto',
  eventBufferSize: 1000,
  writeAllowlist: [],
  wampRecordBufferSize: 20000,
  wampRecordMaxBytes: 67_108_864,
  wampRecordPayloadCap: 512,
  wampRecordFullPayloadUris: ['/lol-gameflow/v1/gameflow-phase'],
  wampRecordFile: null,
  cdpConsoleBufferSize: 5000
};

export function validateConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Config must be a JSON object');
  }
  const config = { ...DEFAULTS, ...raw };
  if (typeof config.allowEval !== 'boolean') {
    throw new Error(`Config "allowEval" must be a boolean, got ${typeof config.allowEval}`);
  }
  if (config.cdpPort === null || config.cdpPort === 'auto') {
    config.cdpPort = 'auto';
  } else if (!Number.isInteger(config.cdpPort) || config.cdpPort < 1 || config.cdpPort > 65535) {
    throw new Error(`Config "cdpPort" must be "auto" or an integer port, got ${JSON.stringify(config.cdpPort)}`);
  }
  if (!Number.isInteger(config.eventBufferSize) || config.eventBufferSize < 1) {
    throw new Error(`Config "eventBufferSize" must be a positive integer, got ${JSON.stringify(config.eventBufferSize)}`);
  }
  for (const key of ['wampRecordBufferSize', 'wampRecordMaxBytes', 'wampRecordPayloadCap', 'cdpConsoleBufferSize']) {
    if (!Number.isInteger(config[key]) || config[key] < 1) {
      throw new Error(`Config "${key}" must be a positive integer, got ${JSON.stringify(config[key])}`);
    }
  }
  if (
    !Array.isArray(config.wampRecordFullPayloadUris) ||
    config.wampRecordFullPayloadUris.some((u) => typeof u !== 'string')
  ) {
    throw new Error('Config "wampRecordFullPayloadUris" must be an array of URI prefix strings');
  }
  if (config.wampRecordFile !== null && typeof config.wampRecordFile !== 'string') {
    throw new Error(`Config "wampRecordFile" must be a path string or null, got ${typeof config.wampRecordFile}`);
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
