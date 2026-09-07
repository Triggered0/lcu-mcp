// Wall-clock-comparable epoch time with nanosecond precision, anchored to the
// epoch at construction. Uses performance.now() (via hrNow) for within-process
// monotonicity, so a downstream CDP consumer or WAMP recorder with a local
// time reference can reconcile even when wall time steps (e.g. NTP correction).
// Epoch passed to construction is treated as constant; subsequent calls to
// epochNow() are deliberately ignored. `wall()` kept alongside it precisely
// so that a step stays visible in data: CDP's own timestamps use raw epoch,
// so under step the two disagree.

export function createClock({ epochNow = Date.now, hrNow = process.hrtime.bigint } = {}) {
  const epochAnchor = epochNow();
  const hrAnchor = hrNow();
  return {
    now: () => epochAnchor + Number(hrNow() - hrAnchor) / 1e6,
    wall: () => epochNow()
  };
}
