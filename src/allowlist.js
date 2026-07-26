export const ALWAYS_ALLOWED = new Set(['GET', 'HEAD']);

function pathMatches(pattern, path) {
  if (!pattern.endsWith('/*')) return pattern === path;
  const prefix = pattern.slice(0, -1);
  if (!path.startsWith(prefix)) return false;
  const rest = path.slice(prefix.length);
  return rest.length > 0 && !rest.includes('/');
}

export function checkWrite(method, path, allowlist = []) {
  const verb = String(method).toUpperCase();
  const line = `${verb} ${path}`;
  if (ALWAYS_ALLOWED.has(verb)) return { allowed: true, line };

  for (const entry of allowlist) {
    const spaceAt = entry.indexOf(' ');
    if (spaceAt === -1) continue;
    const entryVerb = entry.slice(0, spaceAt).toUpperCase();
    const entryPath = entry.slice(spaceAt + 1).trim();
    if (entryVerb === verb && pathMatches(entryPath, path)) return { allowed: true, line: entry };
  }

  return {
    allowed: false,
    line,
    message:
      `${line} is not on the write allowlist. To permit it, add ` +
      `"${line}" to "writeAllowlist" in the config file.`
  };
}
