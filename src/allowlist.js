export const ALWAYS_ALLOWED = new Set(['GET', 'HEAD']);

export function normalizePath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    return null;
  }
  try {
    const unescaped = path.replace(/%2f/gi, '/').replace(/%2e/gi, '.');
    if (unescaped.includes('\0')) return null;
    const url = new URL(unescaped, 'http://localhost');
    return url.pathname;
  } catch {
    return null;
  }
}

function pathMatches(pattern, path) {
  if (pattern === path) return true;
  if (!pattern.includes('/*')) return false;

  const parts = pattern.split('/*');
  if (parts.length !== 2) return false;

  const [prefix, suffix] = parts;
  if (!path.startsWith(prefix + '/')) return false;
  if (suffix.length > 0 && !path.endsWith(suffix)) return false;

  const middle = path.slice(prefix.length + 1, suffix.length > 0 ? -suffix.length : undefined);
  return middle.length > 0 && !middle.includes('/');
}

export function checkWrite(method, path, allowlist = []) {
  const verb = String(method).toUpperCase();
  const line = `${verb} ${path}`;
  if (ALWAYS_ALLOWED.has(verb)) return { allowed: true, line };

  const normPath = normalizePath(path);
  if (normPath === null) {
    return {
      allowed: false,
      line,
      message:
        `${line} is not on the write allowlist. To permit it, add ` +
        `"${line}" to "writeAllowlist" in the config file.`
    };
  }

  for (const entry of allowlist) {
    const spaceAt = entry.indexOf(' ');
    if (spaceAt === -1) continue;
    const entryVerb = entry.slice(0, spaceAt).toUpperCase();
    const entryPath = entry.slice(spaceAt + 1).trim();
    if (entryVerb === verb && pathMatches(entryPath, normPath)) return { allowed: true, line: entry };
  }

  return {
    allowed: false,
    line,
    message:
      `${line} is not on the write allowlist. To permit it, add ` +
      `"${line}" to "writeAllowlist" in the config file.`
  };
}

