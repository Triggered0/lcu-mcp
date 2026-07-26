export function redactUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return rawUrl;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  if (!parsed.password) return rawUrl;
  return rawUrl.replace(`:${parsed.password}@`, ':***@');
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
