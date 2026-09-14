import { redactSecrets } from '../redact.js';

const AUTH_TOKEN_REGEX = /(?:--riotclient-auth-token=|-RiotClientAuthToken=)[^\s"]+/gi;
const RSO_AUTH_REGEX = /--rso_auth=(?:\{[^\s]+|\S+)/gi;
const AUTH_KEY_REGEX = /authorization-key":\s*"[^"]+"/gi;
const BEARER_REGEX = /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi;

export function redactLogText(text, secrets = []) {
  if (typeof text !== 'string') return text;
  let clean = redactSecrets(text, secrets);
  clean = clean.replace(AUTH_TOKEN_REGEX, (match) => {
    const eqIdx = match.indexOf('=');
    return match.slice(0, eqIdx + 1) + '***';
  });
  clean = clean.replace(RSO_AUTH_REGEX, '--rso_auth=***');
  clean = clean.replace(AUTH_KEY_REGEX, 'authorization-key":"***"');
  clean = clean.replace(BEARER_REGEX, 'Bearer ***');
  return clean;
}

const LOG_LINE_REGEX = /^(\d+\.\d+)\|\s*([A-Z]+)\|\s*(?:([A-Za-z0-9_-]+)\|\s*)?(.*)$/;

export function parseLogLine(line, baseWallTime = 0, secrets = []) {
  const cleanLine = redactLogText(line, secrets);
  const match = cleanLine.match(LOG_LINE_REGEX);
  if (!match) {
    return {
      elapsed: null,
      level: 'INFO',
      subsystem: null,
      message: cleanLine,
      wallTime: baseWallTime || null,
      raw: cleanLine
    };
  }

  const elapsed = Number.parseFloat(match[1]);
  const level = match[2].trim();
  const subsystem = match[3] ? match[3].trim() : null;
  const message = match[4];
  const wallTime = baseWallTime ? Math.round(baseWallTime + elapsed * 1000) : null;

  return {
    elapsed: Number.isFinite(elapsed) ? elapsed : null,
    level,
    subsystem,
    message,
    wallTime,
    raw: cleanLine
  };
}
