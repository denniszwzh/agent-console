export const MAX_FAILURES = 5;
export const WINDOW_MS = 15 * 60_000;
export const LOCK_MS = 15 * 60_000;

export type LimitCheck = { locked: false } | { locked: true; retryAfterSec: number };

interface Entry {
  failures: number[]; // timestamps of failures inside the window
  lockedUntil: number; // 0 when not locked
}

const MAPPED_PREFIX = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

// Only the IPv4-mapped form is folded onto its IPv4 address; anything else is kept as given.
function normalise(ip: string): string {
  const m = MAPPED_PREFIX.exec(ip);
  return m ? m[1] : ip;
}

export class LoginLimiter {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  check(ip: string): LimitCheck {
    const key = normalise(ip);
    this.prune(this.now());
    const entry = this.entries.get(key);
    if (entry && entry.lockedUntil > 0) {
      return { locked: true, retryAfterSec: Math.max(1, Math.ceil((entry.lockedUntil - this.now()) / 1000)) };
    }
    return { locked: false };
  }

  fail(ip: string): void {
    const key = normalise(ip);
    const t = this.now();
    this.prune(t);
    let entry = this.entries.get(key);
    if (entry && entry.lockedUntil > 0) return; // failures while locked do not extend the lock
    if (!entry) {
      entry = { failures: [], lockedUntil: 0 };
      this.entries.set(key, entry);
    }
    entry.failures.push(t);
    if (entry.failures.length >= MAX_FAILURES) {
      entry.lockedUntil = t + LOCK_MS;
      entry.failures = [];
    }
  }

  succeed(ip: string): void {
    this.entries.delete(normalise(ip));
  }

  // Drop expired locks and out-of-window failures so the map cannot grow without bound.
  private prune(t: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.lockedUntil > 0) {
        if (entry.lockedUntil <= t) this.entries.delete(key);
        continue;
      }
      entry.failures = entry.failures.filter((f) => t - f <= WINDOW_MS);
      if (entry.failures.length === 0) this.entries.delete(key);
    }
  }
}
