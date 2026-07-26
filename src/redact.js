// Work on the raw string only. `new URL(...).password` returns the
// percent-encoded form, which stops matching the literal text as soon as the
// password holds a character from the userinfo encode set — the replace then
// silently misses and the whole credential comes back in cleartext.
// Slicing also avoids building a regex out of the secret. The authority runs to
// the first `/`, and the split point is its LAST `@`, so a password containing
// `@`, `?`, or a regex metacharacter is still redacted whole.
export function redactUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return rawUrl;
  const schemeEnd = rawUrl.indexOf('://');
  if (schemeEnd === -1) return rawUrl;
  const authorityStart = schemeEnd + 3;
  const slash = rawUrl.indexOf('/', authorityStart);
  const authorityEnd = slash === -1 ? rawUrl.length : slash;
  const at = rawUrl.lastIndexOf('@', authorityEnd - 1);
  if (at < authorityStart) return rawUrl;
  const colon = rawUrl.indexOf(':', authorityStart);
  if (colon === -1 || colon > at) return rawUrl; // userinfo carries no password
  return `${rawUrl.slice(0, colon + 1)}***${rawUrl.slice(at)}`;
}

export function redactSecrets(text, secrets = []) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length === 0) continue;
    out = out.split(secret).join('***');
  }
  return out;
}
