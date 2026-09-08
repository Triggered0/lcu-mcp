import { readFile } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { redactUrl } from '../redact.js';

const execAsync = promisify(exec);
export const DEFAULT_PENGU_CONFIG_PATH = 'C:\\Program Files\\Pengu Loader\\config';

let cachedPortResolution = null;

export function clearPortCache() {
  cachedPortResolution = null;
}

export async function readPenguConfig(path = process.env.PENGU_CONFIG_PATH ?? DEFAULT_PENGU_CONFIG_PATH) {
  try {
    const text = await readFile(path, 'utf8');
    const match = text.match(/^RemoteDebuggingPort\s*=\s*(\d+)/m);
    if (!match) return null;
    const port = Number(match[1]);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

export async function findProcessCdpPort({
  execCmd = async (cmd) => (await execAsync(cmd)).stdout,
  platform = process.platform
} = {}) {
  if (platform !== 'win32') return null;
  try {
    const cmd = 'powershell.exe -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process -Filter \\"Name LIKE \'LeagueClientUxRender%\'\\" | Select-Object -ExpandProperty CommandLine"';
    const output = await execCmd(cmd);
    if (typeof output !== 'string') return null;
    const match = output.match(/--remote-debugging-port=(\d+)/);
    if (!match) return null;
    const port = Number(match[1]);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

export async function resolveCdpPort({
  config = {},
  env = process.env,
  forceRefresh = false,
  readConfigFile = readPenguConfig,
  scanProcesses = findProcessCdpPort
} = {}) {
  if (!forceRefresh && cachedPortResolution !== null) {
    return cachedPortResolution;
  }

  if (Number.isInteger(config?.cdpPort) && config.cdpPort >= 1 && config.cdpPort <= 65535) {
    cachedPortResolution = { port: config.cdpPort, source: 'explicit' };
    return cachedPortResolution;
  }

  if (env?.LCU_CDP_PORT && /^\d+$/.test(String(env.LCU_CDP_PORT))) {
    const port = Number(env.LCU_CDP_PORT);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      cachedPortResolution = { port, source: 'env' };
      return cachedPortResolution;
    }
  }

  const filePort = await readConfigFile();
  if (filePort !== null) {
    cachedPortResolution = { port: filePort, source: 'pengu-config' };
    return cachedPortResolution;
  }

  const procPort = await scanProcesses();
  if (procPort !== null) {
    cachedPortResolution = { port: procPort, source: 'process' };
    return cachedPortResolution;
  }

  cachedPortResolution = { port: 8888, source: 'fallback' };
  return cachedPortResolution;
}


export class CdpUnavailableError extends Error {
  constructor(port, detail) {
    super(
      `CDP unavailable on port ${port}: Pengu Loader not active or RemoteDebuggingPort unset. ` +
        `${penguHint(port)}${detail ? ` (${detail})` : ''}`
    );
    this.name = 'CdpUnavailableError';
    this.port = port;
  }
}

export function penguHint(port) {
  return (
    `Set RemoteDebuggingPort=${port} in "C:\\Program Files\\Pengu Loader\\config" ` +
    '(plain key=value text, one pair per line), then restart the UX with ' +
    'POST /riotclient/kill-and-restart-ux.'
  );
}

async function getJson(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response.json();
}

export function redactTarget(target) {
  const out = { ...target };
  if (typeof out.url === 'string') out.url = redactUrl(out.url);
  if (typeof out.faviconUrl === 'string') out.faviconUrl = redactUrl(out.faviconUrl);
  return out;
}

export async function probeVersion(port) {
  try {
    return await getJson(port, '/json/version');
  } catch (err) {
    throw new CdpUnavailableError(port, err.cause?.code ?? err.message);
  }
}

export async function listTargets(port) {
  let targets;
  try {
    targets = await getJson(port, '/json/list');
  } catch (err) {
    throw new CdpUnavailableError(port, err.cause?.code ?? err.message);
  }
  if (!Array.isArray(targets)) return [];
  return targets.map(redactTarget);
}

export async function findPageTarget(port) {
  const targets = await listTargets(port);
  const page = targets.find((t) => t.type === 'page');
  if (!page) {
    throw new Error(
      `CDP on port ${port} is reachable but exposes no "page" target. ` +
        'The client UX may still be starting; retry once it is visible.'
    );
  }
  return page;
}
