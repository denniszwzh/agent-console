import { beforeEach, describe, expect, it } from 'vitest';
import { LOCK_MS, LoginLimiter, MAX_FAILURES, WINDOW_MS } from '../../src/server/remote/limiter.js';

const IP = '203.0.113.5';

describe('LoginLimiter', () => {
  let t: number;
  let limiter: LoginLimiter;
  const failTimes = (ip: string, n: number) => { for (let i = 0; i < n; i++) limiter.fail(ip); };

  beforeEach(() => {
    t = 1_000_000_000_000;
    limiter = new LoginLimiter(() => t);
  });

  it('exports the documented limits', () => {
    expect([MAX_FAILURES, WINDOW_MS, LOCK_MS]).toEqual([5, 900_000, 900_000]);
  });

  it('locks an ip after 5 failures within 15 minutes', () => {
    failTimes(IP, 4);
    expect(limiter.check(IP)).toEqual({ locked: false });
    limiter.fail(IP);
    expect(limiter.check(IP)).toEqual({ locked: true, retryAfterSec: 900 });
  });

  it('rounds retryAfterSec up and never reports 0 while locked', () => {
    failTimes(IP, 5);
    t += LOCK_MS - 1;
    expect(limiter.check(IP)).toEqual({ locked: true, retryAfterSec: 1 });
  });

  it('failures older than the window do not count', () => {
    failTimes(IP, 4);
    t += WINDOW_MS + 1;
    limiter.fail(IP);
    expect(limiter.check(IP)).toEqual({ locked: false });
    failTimes(IP, 3);
    expect(limiter.check(IP)).toEqual({ locked: false });
    limiter.fail(IP);
    expect(limiter.check(IP).locked).toBe(true);
  });

  it('unlocks after 15 minutes and starts counting afresh', () => {
    failTimes(IP, 5);
    t += LOCK_MS;
    expect(limiter.check(IP)).toEqual({ locked: false });
    failTimes(IP, 4);
    expect(limiter.check(IP)).toEqual({ locked: false });
  });

  it('failures while locked do not extend the lock', () => {
    failTimes(IP, 5);
    t += 10 * 60_000;
    failTimes(IP, 3);
    expect(limiter.check(IP)).toEqual({ locked: true, retryAfterSec: 300 });
    t += 5 * 60_000;
    expect(limiter.check(IP)).toEqual({ locked: false });
    failTimes(IP, 4);
    expect(limiter.check(IP)).toEqual({ locked: false });
  });

  it('other ips are not affected', () => {
    failTimes(IP, 5);
    expect(limiter.check('198.51.100.7')).toEqual({ locked: false });
  });

  it('succeed clears the failure count', () => {
    failTimes(IP, 4);
    limiter.succeed(IP);
    failTimes(IP, 4);
    expect(limiter.check(IP)).toEqual({ locked: false });
  });

  it('treats IPv4-mapped addresses as the same ip', () => {
    failTimes('::ffff:10.0.0.5', 3);
    failTimes('10.0.0.5', 2);
    expect(limiter.check('10.0.0.5').locked).toBe(true);
    expect(limiter.check('::FFFF:10.0.0.5').locked).toBe(true);
  });

  it('leaves other addresses as given', () => {
    failTimes('2001:db8::1', 5);
    expect(limiter.check('2001:db8::1').locked).toBe(true);
    expect(limiter.check('2001:db8::2').locked).toBe(false);
  });
});
