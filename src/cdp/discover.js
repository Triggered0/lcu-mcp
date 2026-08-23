import { redactUrl } from '../redact.js';

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
    `Set RemoteDebuggingPort=${port} in "C:\Program Files\Pengu Loader\config" ` +
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

export async function findPageTarget(port) {
  let targets;
  try {
    targets = await getJson(port, '/json/list');
  } catch (err) {
    throw new CdpUnavailableError(port, err.cause?.code ?? err.message);
  }
  const page = Array.isArray(targets) ? targets.find((t) => t.type === 'page') : null;
  if (!page) {
    throw new Error(
      `CDP on port ${port} is reachable but exposes no "page" target. ` +
        'The client UX may still be starting; retry once it is visible.'
    );
  }
  return redactTarget(page);
}
