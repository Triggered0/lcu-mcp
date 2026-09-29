import { redactSecrets } from '../redact.js';

const AUTH_TOKEN_REGEX = /(?:--riotclient-auth-token=|-RiotClientAuthToken=)[^\s"]+/gi;
const RSO_AUTH_REGEX = /--rso_auth=(?:\{[^\s]+|\S+)/gi;
const AUTH_KEY_REGEX = /authorization-key":\s*"[^"]+"/gi;
const BEARER_REGEX = /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const JWT_REGEX = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]*)?/g;
const SENSITIVE_KV_REGEX = /(?:^|[;&\s])(session[-_]?id|token|authToken|password|auth_key)=[^;&\s]+/gi;

export function buildStorageExtractionScript({ storageType = 'all' } = {}) {
  const typeJson = JSON.stringify(storageType);
  return `(() => {
    try {
      const dump = (storage) => {
        if (!storage) return [];
        const items = [];
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (key !== null) {
            items.push({ key, value: storage.getItem(key) });
          }
        }
        return items;
      };
      const type = ${typeJson};
      let local = [];
      let session = [];
      if (type === 'all' || type === 'local') {
        try { local = dump(window.localStorage); } catch (e) { local = []; }
      }
      if (type === 'all' || type === 'session') {
        try { session = dump(window.sessionStorage); } catch (e) { session = []; }
      }
      return { localStorage: local, sessionStorage: session };
    } catch (err) {
      return { error: err.message };
    }
  })()`;
}

function isSensitiveKey(key) {
  if (typeof key !== 'string') return false;
  if (/^feature[-_.]?flag/i.test(key) && /enabled|disabled|active|allowed/i.test(key)) {
    return false;
  }
  const normalized = key.toLowerCase().replace(/[-_.]/g, '');
  if (/(password|passwd|secret|credential|cookie|jwt|bearer|privatekey|apikey)/.test(normalized)) {
    return true;
  }
  if (
    /(token|auth)$/.test(normalized) ||
    /^(authtoken|accesstoken|refreshtoken|idtoken|sessiontoken|riottoken|riotclientauthtoken)$/.test(normalized)
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
  out = out.replace(BEARER_REGEX, 'Bearer ***');
  out = out.replace(JWT_REGEX, '***');
  out = out.replace(SENSITIVE_KV_REGEX, (match) => {
    const eq = match.indexOf('=');
    return match.slice(0, eq + 1) + '***';
  });
  return out;
}

function deepRedactValue(val, secrets = []) {
  if (typeof val === 'string') {
    return redactString(val, secrets);
  }
  if (Array.isArray(val)) {
    return val.map((item) => deepRedactValue(item, secrets));
  }
  if (val !== null && typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      if (isSensitiveKey(k)) {
        out[k] = '***';
      } else {
        out[k] = deepRedactValue(v, secrets);
      }
    }
    return out;
  }
  return val;
}

function normalizeEntries(items) {
  if (!items) return [];
  if (Array.isArray(items)) {
    return items
      .map((item) => {
        if (item && typeof item === 'object' && 'key' in item) {
          return { key: String(item.key), value: item.value };
        }
        if (Array.isArray(item) && item.length >= 2) {
          return { key: String(item[0]), value: item[1] };
        }
        return null;
      })
      .filter(Boolean);
  }
  if (typeof items === 'object') {
    return Object.entries(items).map(([key, value]) => ({ key, value }));
  }
  return [];
}

function matchesFilter(entry, filterLower) {
  if (!filterLower) return true;
  if (entry.key.toLowerCase().includes(filterLower)) return true;
  const valStr = typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value);
  if (valStr && valStr.toLowerCase().includes(filterLower)) return true;
  return false;
}

export function parseStorageEntries(rawEntries, options = {}) {
  const {
    storageType = 'all',
    filter = null,
    limit = 100,
    parseJson = true,
    secrets = []
  } = options;

  if (!rawEntries || typeof rawEntries !== 'object') {
    return {
      localStorage: [],
      sessionStorage: [],
      totalKeys: 0,
      matchedKeys: 0,
      summary: 'No storage data available'
    };
  }

  const rawLocal = storageType === 'session' ? [] : normalizeEntries(rawEntries.localStorage);
  const rawSession = storageType === 'local' ? [] : normalizeEntries(rawEntries.sessionStorage);
  const totalKeys = rawLocal.length + rawSession.length;

  const filterLower = typeof filter === 'string' && filter.trim().length > 0 ? filter.trim().toLowerCase() : null;

  const matchedLocal = rawLocal.filter((entry) => matchesFilter(entry, filterLower));
  const matchedSession = rawSession.filter((entry) => matchesFilter(entry, filterLower));
  const matchedKeys = matchedLocal.length + matchedSession.length;

  const secretsList = typeof secrets === 'function' ? secrets() : (Array.isArray(secrets) ? secrets : []);

  function processEntry(entry) {
    const key = entry.key;
    let value = entry.value;

    if (isSensitiveKey(key)) {
      return { key, value: '***' };
    }

    if (parseJson && typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        value = deepRedactValue(parsed, secretsList);
      } catch {
        value = redactString(value, secretsList);
      }
    } else if (typeof value === 'string') {
      value = redactString(value, secretsList);
    } else {
      value = deepRedactValue(value, secretsList);
    }

    return { key, value };
  }

  const finalLocal = matchedLocal.slice(0, limit).map(processEntry);
  const finalSession = matchedSession.slice(0, limit).map(processEntry);

  const targetTypeStr =
    storageType === 'all'
      ? 'localStorage and sessionStorage'
      : storageType === 'local'
        ? 'localStorage'
        : 'sessionStorage';

  let summary = '';
  if (filterLower) {
    summary = `Found ${matchedKeys} matched key(s) (filtered by "${filter}") out of ${totalKeys} total key(s) across ${targetTypeStr}`;
  } else {
    if (storageType === 'all') {
      summary = `Retrieved ${matchedLocal.length} localStorage and ${matchedSession.length} sessionStorage key(s) (${totalKeys} total keys)`;
    } else if (storageType === 'local') {
      summary = `Retrieved ${matchedLocal.length} localStorage key(s) (${totalKeys} total keys)`;
    } else {
      summary = `Retrieved ${matchedSession.length} sessionStorage key(s) (${totalKeys} total keys)`;
    }
  }

  if (finalLocal.length < matchedLocal.length || finalSession.length < matchedSession.length) {
    summary += ` (truncated to limit ${limit})`;
  }

  return {
    localStorage: finalLocal,
    sessionStorage: finalSession,
    totalKeys,
    matchedKeys,
    summary
  };
}

export async function inspectStorage(cdp, options = {}) {
  const expression = buildStorageExtractionScript(options);
  const { value, exceptionDetails } = await cdp.evaluate(expression);
  if (exceptionDetails) {
    throw new Error(
      `CDP storage inspection failed: ${exceptionDetails.description || exceptionDetails.text || 'unknown error'}`
    );
  }
  if (value?.error) {
    throw new Error(`Storage inspection script failed: ${value.error}`);
  }
  return parseStorageEntries(value, options);
}
