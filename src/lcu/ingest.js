export const MAX_DATA_BYTES = 4096;

export function matchesFilters(uri, filters) {
  if (!Array.isArray(filters) || filters.length === 0) return true;
  return filters.some((prefix) => typeof uri === 'string' && uri.startsWith(prefix));
}

export function truncateData(data, max = MAX_DATA_BYTES) {
  if (data === undefined || data === null) return { data, truncated: false };
  let json;
  try {
    json = JSON.stringify(data);
  } catch {
    // Circular or otherwise unserialisable: report it rather than throwing at
    // the caller, which is on the ingest path for every event.
    return { data: '[unserialisable]', truncated: true };
  }
  if (json === undefined) return { data, truncated: false };
  // The cap is in bytes, so measure bytes: a Korean or emoji-heavy payload is
  // 3-4 bytes per character, and a character-count cap would let through
  // several times the intended size. Slicing the Buffer can also land inside a
  // multi-byte sequence, so drop the trailing partial character.
  if (Buffer.byteLength(json, 'utf8') <= max) return { data, truncated: false };
  const cut = Buffer.from(json, 'utf8').subarray(0, max).toString('utf8').replace(/�+$/, '');
  return { data: cut, truncated: true };
}

// The subscribe ack arrives as an empty frame; parsing it as JSON throws.
export function decodeFrame(raw) {
  const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
  if (text.trim().length === 0) return null;
  let frame;
  try {
    frame = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(frame) || frame[0] !== 8 || frame[1] !== 'OnJsonApiEvent') return null;
  const payload = frame[2];
  if (payload === null || typeof payload !== 'object') return null;
  return { eventType: payload.eventType, uri: payload.uri, data: payload.data };
}
