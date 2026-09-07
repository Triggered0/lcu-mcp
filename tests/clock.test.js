import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClock } from '../src/clock.js';

test('now anchored epoch at construction', () => {
  let hr = 0n;
  const clock = createClock({ epochNow: () => 1_700_000_000_000, hrNow: () => hr });
  hr = 1_500_000n; // 1.5 ms later in nanoseconds
  assert.equal(clock.now(), 1_700_000_000_001.5);
});

test('now survives wall-clock step wall does not', () => {
  let hr = 0n;
  let epoch = 1_700_000_000_000;
  const clock = createClock({ epochNow: () => epoch, hrNow: () => hr });

  hr = 5_000_000n; // 5 ms real time passes
  epoch = 1_699_999_000_000; // NTP steps wall clock one second backwards

  assert.equal(clock.now(), 1_700_000_000_005); // unaffected by step
  assert.equal(clock.wall(), 1_699_999_000_000); // reports step honestly
});

test('now sub-millisecond resolution', () => {
  let hr = 0n;
  const clock = createClock({ epochNow: () => 1_000, hrNow: () => hr });
  hr = 250_000n; // 0.25 ms
  assert.equal(clock.now(), 1_000.25);
});
