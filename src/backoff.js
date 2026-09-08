// Shared by the event tap, the WAMP recorder and the CDP console tailer.
export function backoffDelay(attempt) {
  return Math.min(30000, 1000 * 2 ** attempt);
}
