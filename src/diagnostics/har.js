import { redactSecrets, redactUrl } from '../redact.js';

const BEARER_REGEX = /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const BASIC_REGEX = /Basic\s+[A-Za-z0-9+/=]+/gi;
const JWT_REGEX = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]*)?/g;
const AUTH_TOKEN_REGEX = /(?:--riotclient-auth-token=|-RiotClientAuthToken=)[^\s"]+/gi;
const RSO_AUTH_REGEX = /--rso_auth=(?:\{[^\s]+|\S+)/gi;
const AUTH_KEY_REGEX = /authorization-key":\s*"[^"]+"/gi;
const SENSITIVE_KV_REGEX = /(?:^|[;&\s])(session[-_]?id|token|authToken|password|auth_key)=[^;&\s]+/gi;

function isSensitiveKey(key) {
  if (typeof key !== 'string') return false;
  const normalized = key.toLowerCase().replace(/[-_.]/g, '');
  if (/(password|passwd|secret|credential|cookie|jwt|bearer|privatekey|apikey|session)/.test(normalized)) {
    return true;
  }
  if (
    /(token|auth|session|sessionid|sid|ssid)$/.test(normalized) ||
    /^(authtoken|accesstoken|refreshtoken|idtoken|sessiontoken|sessionid|sid|ssid|riottoken|riotclientauthtoken)$/.test(normalized)
  ) {
    return true;
  }
  return false;
}

function redactString(text, secrets = []) {
  if (typeof text !== 'string') return text;
  let out = redactSecrets(text, secrets);
  out = out.replace(AUTH_TOKEN_REGEX, (match) => {
    const eq = match.indexOf('=');
    return match.slice(0, eq + 1) + '***';
  });
  out = out.replace(RSO_AUTH_REGEX, '--rso_auth=***');
  out = out.replace(AUTH_KEY_REGEX, 'authorization-key":"***"');
  out = out.replace(BASIC_REGEX, 'Basic ***');
  out = out.replace(BEARER_REGEX, 'Bearer ***');
  out = out.replace(JWT_REGEX, '***');
  out = out.replace(SENSITIVE_KV_REGEX, (match) => {
    const eq = match.indexOf('=');
    return match.slice(0, eq + 1) + '***';
  });
  return out;
}

function deepRedactJson(val, secrets = []) {
  if (typeof val === 'string') {
    return redactString(val, secrets);
  }
  if (Array.isArray(val)) {
    return val.map((item) => deepRedactJson(item, secrets));
  }
  if (val !== null && typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      if (isSensitiveKey(k)) {
        out[k] = '***';
      } else {
        out[k] = deepRedactJson(v, secrets);
      }
    }
    return out;
  }
  return val;
}

function sanitizeBody(body, secrets = []) {
  if (typeof body !== 'string') return body;
  try {
    const parsed = JSON.parse(body);
    const redacted = deepRedactJson(parsed, secrets);
    return JSON.stringify(redacted);
  } catch {
    return redactString(body, secrets);
  }
}

function sanitizeUrl(rawUrl, secrets = []) {
  if (typeof rawUrl !== 'string') return '';
  let clean = redactUrl(rawUrl);
  clean = redactSecrets(clean, secrets);
  try {
    const parsed = new URL(clean, 'https://127.0.0.1');
    let changed = false;
    for (const [key, val] of parsed.searchParams.entries()) {
      if (isSensitiveKey(key) && val !== '***') {
        parsed.searchParams.set(key, '***');
        changed = true;
      }
    }
    if (changed) {
      if (clean.startsWith('http://') || clean.startsWith('https://')) {
        clean = parsed.href;
      } else {
        clean = parsed.pathname + parsed.search + parsed.hash;
      }
    }
  } catch {
    // Ignore URL parsing errors
  }
  return clean;
}

function extractQueryString(urlStr, secrets = []) {
  if (typeof urlStr !== 'string') return [];
  try {
    const urlObj = new URL(urlStr, 'https://127.0.0.1');
    const query = [];
    for (const [name, value] of urlObj.searchParams.entries()) {
      const cleanName = redactString(name, secrets);
      let cleanVal = redactString(value, secrets);
      if (isSensitiveKey(name) || isSensitiveKey(cleanName)) {
        cleanVal = '***';
      }
      query.push({ name: cleanName, value: cleanVal });
    }
    return query;
  } catch {
    const qIndex = urlStr.indexOf('?');
    if (qIndex === -1) return [];
    const queryPart = urlStr.slice(qIndex + 1).split('#')[0];
    const pairs = queryPart.split('&');
    const query = [];
    for (const pair of pairs) {
      if (!pair) continue;
      const [k, v = ''] = pair.split('=');
      const decodedKey = decodeURIComponent(k);
      const decodedVal = decodeURIComponent(v);
      const cleanName = redactString(decodedKey, secrets);
      let cleanVal = redactString(decodedVal, secrets);
      if (isSensitiveKey(decodedKey) || isSensitiveKey(cleanName)) {
        cleanVal = '***';
      }
      query.push({ name: cleanName, value: cleanVal });
    }
    return query;
  }
}

function sanitizeHeaderValue(name, value, secrets = []) {
  if (typeof value !== 'string') value = String(value ?? '');
  const lowerName = name.toLowerCase();

  // Authorization header
  if (lowerName === 'authorization' || lowerName === 'proxy-authorization') {
    if (/^Basic\s+/i.test(value)) return 'Basic ***';
    if (/^Bearer\s+/i.test(value)) return 'Bearer ***';
    return '***';
  }

  // Riot auth headers
  if (
    lowerName === 'riot-client-auth' ||
    lowerName === 'x-riot-entitlements-jwt' ||
    lowerName === 'x-rso-auth' ||
    lowerName === 'riot-token'
  ) {
    return '***';
  }

  // Cookie header
  if (lowerName === 'cookie') {
    const parts = value.split(';');
    const sanitizedParts = parts.map((part) => {
      const trimmed = part.trim();
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) return redactString(trimmed, secrets);
      const k = trimmed.slice(0, eqIdx);
      const v = trimmed.slice(eqIdx + 1);
      if (isSensitiveKey(k)) {
        return `${k}=***`;
      }
      return `${k}=${redactString(v, secrets)}`;
    });
    return sanitizedParts.join('; ');
  }

  // Set-Cookie header
  if (lowerName === 'set-cookie') {
    const parts = value.split(';');
    const first = parts[0] || '';
    const rest = parts.slice(1);
    const eqIdx = first.indexOf('=');
    let newFirst = first;
    if (eqIdx !== -1) {
      const k = first.slice(0, eqIdx);
      const v = first.slice(eqIdx + 1);
      if (isSensitiveKey(k)) {
        newFirst = `${k}=***`;
      } else {
        newFirst = `${k}=${redactString(v, secrets)}`;
      }
    } else {
      newFirst = redactString(first, secrets);
    }
    return [newFirst, ...rest.map((r) => redactString(r, secrets))].join(';');
  }

  if (isSensitiveKey(name)) {
    return '***';
  }

  return redactString(value, secrets);
}

function sanitizeHeaders(rawHeaders, secrets = []) {
  if (!rawHeaders) return [];
  let list = [];
  if (Array.isArray(rawHeaders)) {
    list = rawHeaders.filter((h) => h && typeof h === 'object');
  } else if (typeof rawHeaders === 'object') {
    list = Object.entries(rawHeaders).map(([name, value]) => ({ name, value }));
  }
  return list.map((h) => {
    const name = String(h.name ?? '');
    const value = sanitizeHeaderValue(name, h.value, secrets);
    return { name, value };
  });
}

function parseCookieHeader(cookieHeaderValue) {
  if (!cookieHeaderValue || typeof cookieHeaderValue !== 'string') return [];
  return cookieHeaderValue
    .split(';')
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return null;
      const eq = trimmed.indexOf('=');
      if (eq === -1) return { name: trimmed, value: '' };
      return { name: trimmed.slice(0, eq), value: trimmed.slice(eq + 1) };
    })
    .filter(Boolean);
}

function sanitizeCookies(rawCookies, secrets = []) {
  if (!rawCookies) return [];
  let list = [];
  if (Array.isArray(rawCookies)) {
    list = rawCookies;
  } else if (typeof rawCookies === 'object') {
    list = Object.entries(rawCookies).map(([name, value]) => ({ name, value: String(value) }));
  }
  return list.map((c) => {
    const name = redactString(String(c.name ?? ''), secrets);
    let value = redactString(String(c.value ?? ''), secrets);
    if (isSensitiveKey(name) || isSensitiveKey(String(c.name ?? ''))) {
      value = '***';
    }
    return {
      name,
      value,
      ...(c.path !== undefined ? { path: c.path } : {}),
      ...(c.domain !== undefined ? { domain: c.domain } : {}),
      ...(c.expires !== undefined ? { expires: c.expires } : {}),
      ...(c.httpOnly !== undefined ? { httpOnly: c.httpOnly } : {}),
      ...(c.secure !== undefined ? { secure: c.secure } : {})
    };
  });
}

function buildHarEntry(entry, secrets = []) {
  let startedDateTime;
  if (typeof entry.startedDateTime === 'string') {
    startedDateTime = entry.startedDateTime;
  } else if (typeof entry.startedAt === 'number') {
    startedDateTime = new Date(entry.startedAt).toISOString();
  } else {
    startedDateTime = new Date().toISOString();
  }

  let durationMs = 0;
  if (typeof entry.time === 'number') {
    durationMs = Math.max(0, entry.time);
  } else if (typeof entry.durationMs === 'number') {
    durationMs = Math.max(0, entry.durationMs);
  }

  const rawUrl = entry.url || entry.request?.url || '';
  const url = sanitizeUrl(rawUrl, secrets);
  const queryString = extractQueryString(rawUrl, secrets);

  const rawReqHeaders = entry.requestHeaders || entry.request?.headers || entry.headers;
  const reqHeaders = sanitizeHeaders(rawReqHeaders, secrets);

  let rawReqCookies = entry.cookies || entry.request?.cookies;
  if (!rawReqCookies) {
    const cookieHdr = reqHeaders.find((h) => h.name.toLowerCase() === 'cookie');
    if (cookieHdr) {
      rawReqCookies = parseCookieHeader(cookieHdr.value);
    }
  }
  const reqCookies = sanitizeCookies(rawReqCookies, secrets);

  let postData = null;
  const rawPostData = entry.postData || entry.request?.postData;
  if (rawPostData) {
    let mimeType = 'application/json';
    let text = '';
    if (typeof rawPostData === 'string') {
      text = rawPostData;
    } else if (typeof rawPostData === 'object') {
      mimeType = rawPostData.mimeType || mimeType;
      text = rawPostData.text || '';
    }
    postData = {
      mimeType,
      text: sanitizeBody(text, secrets)
    };
  }

  const reqBodySize = postData ? Buffer.byteLength(postData.text, 'utf8') : 0;

  const rawResHeaders = entry.responseHeaders || entry.response?.headers;
  const resHeaders = sanitizeHeaders(rawResHeaders, secrets);

  let rawResCookies = entry.responseCookies || entry.response?.cookies;
  if (!rawResCookies) {
    const setCookieHdr = resHeaders.find((h) => h.name.toLowerCase() === 'set-cookie');
    if (setCookieHdr) {
      rawResCookies = parseCookieHeader(setCookieHdr.value);
    }
  }
  const resCookies = sanitizeCookies(rawResCookies, secrets);

  let status = 200;
  if (typeof entry.status === 'number') {
    status = entry.status;
  } else if (typeof entry.response?.status === 'number') {
    status = entry.response.status;
  } else if (entry.failed) {
    status = 0;
  }

  let statusText = '';
  if (typeof entry.statusText === 'string') {
    statusText = entry.statusText;
  } else if (typeof entry.response?.statusText === 'string') {
    statusText = entry.response.statusText;
  } else if (entry.failed) {
    statusText = entry.errorText || 'Failed';
  } else if (status === 200) {
    statusText = 'OK';
  }

  const rawResBody = entry.body || entry.responseBody || entry.response?.content?.text;
  const cleanResBody = typeof rawResBody === 'string' ? sanitizeBody(rawResBody, secrets) : undefined;
  const contentMimeType = entry.mimeType || entry.response?.content?.mimeType || 'application/json';
  const contentSize =
    typeof entry.bytes === 'number'
      ? entry.bytes
      : typeof entry.response?.content?.size === 'number'
        ? entry.response.content.size
        : cleanResBody
          ? Buffer.byteLength(cleanResBody, 'utf8')
          : 0;

  const responseContent = {
    size: contentSize,
    mimeType: contentMimeType
  };
  if (cleanResBody !== undefined) {
    responseContent.text = cleanResBody;
  }
  if (entry.response?.content?.encoding) {
    responseContent.encoding = entry.response.content.encoding;
  }

  const responseBodySize =
    typeof entry.bytes === 'number'
      ? entry.bytes
      : typeof entry.response?.bodySize === 'number'
        ? entry.response.bodySize
        : -1;

  const timings =
    entry.timings && typeof entry.timings === 'object'
      ? {
          send: typeof entry.timings.send === 'number' ? entry.timings.send : 0,
          wait: typeof entry.timings.wait === 'number' ? entry.timings.wait : durationMs,
          receive: typeof entry.timings.receive === 'number' ? entry.timings.receive : 0
        }
      : {
          send: 0,
          wait: durationMs,
          receive: 0
        };

  const harEntry = {
    startedDateTime,
    time: durationMs,
    request: {
      method: (entry.method || entry.request?.method || 'GET').toUpperCase(),
      url,
      httpVersion: entry.httpVersion || entry.request?.httpVersion || 'HTTP/1.1',
      cookies: reqCookies,
      headers: reqHeaders,
      queryString,
      headersSize: entry.request?.headersSize ?? -1,
      bodySize: reqBodySize
    },
    response: {
      status,
      statusText,
      httpVersion: entry.httpVersion || entry.response?.httpVersion || 'HTTP/1.1',
      cookies: resCookies,
      headers: resHeaders,
      content: responseContent,
      redirectURL: entry.redirectURL || entry.response?.redirectURL || '',
      headersSize: entry.response?.headersSize ?? -1,
      bodySize: responseBodySize
    },
    cache: entry.cache || {},
    timings
  };

  if (postData) {
    harEntry.request.postData = postData;
  }

  return harEntry;
}

export function buildHarArchive(networkEntries = [], options = {}) {
  const {
    secrets = [],
    creatorName = 'lcu-mcp',
    creatorVersion = '1.0.0'
  } = options;

  const secretsList = typeof secrets === 'function' ? secrets() : Array.isArray(secrets) ? secrets : [];

  const validEntries = (Array.isArray(networkEntries) ? networkEntries : []).filter(
    (e) => e && (e.kind === 'request' || (!e.kind && Boolean(e.url || e.request?.url)))
  );

  const entries = validEntries.map((e) => buildHarEntry(e, secretsList));

  return {
    log: {
      version: '1.2',
      creator: {
        name: creatorName,
        version: creatorVersion
      },
      entries
    }
  };
}
