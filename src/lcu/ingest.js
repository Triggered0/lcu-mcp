export const MAX_DATA_BYTES = 4096;

export function matchesFilters(uri, filters) {
  if (!Array.isArray(filters) || filters.length === 0) return true;
  return filters.some((prefix) => typeof uri === 'string' && uri.startsWith(prefix));
}

export function truncateData(data, max = MAX_DATA_BYTES) {
  if (data === undefined || data === null) return { data, truncated: false };
  const json = JSON.stringify(data);
  if (json === undefined || json.length <= max) return { data, truncated: false };
  return { data: json.slice(0, max), truncated: true };
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
