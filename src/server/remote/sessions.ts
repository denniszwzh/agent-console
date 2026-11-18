import crypto from 'node:crypto';
import fs from 'node:fs';

export interface SessionMeta { ip: string; userAgent: string }
export type SessionCheck = { valid: false } | { valid: true; key: string; refresh: boolean };

interface SessionRecord {
  key: string; // sha256(id) hex; the id itself is never stored
  createdAt: number;
  lastSeen: number;
  expiresAt: number;
  issuedAt: number; // when the cookie was last (re)issued to the client
  epoch: number;
  ip: string;
  userAgent: string;
}

const DAY_MS = 86_400_000;
const REFRESH_AFTER_MS = DAY_MS;
const ID_RE = /^[0-9a-f]{64}$/;

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

function isRecord(v: unknown): v is SessionRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
  return (
    typeof r.key === 'string' && ID_RE.test(r.key) &&
    num(r.createdAt) && num(r.lastSeen) && num(r.expiresAt) && num(r.issuedAt) && num(r.epoch) &&
    typeof r.ip === 'string' && typeof r.userAgent === 'string'
  );
}

export class SessionStore {
  private readonly file: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(opts: { file: string; sessionDays: number; now?: () => number }) {
    this.file = opts.file;
    this.ttlMs = opts.sessionDays * DAY_MS;
    this.now = opts.now ?? Date.now;
    this.load();
  }

  create(epoch: number, meta: SessionMeta): { id: string; key: string } {
    const id = crypto.randomBytes(32).toString('hex');
    const key = sha256(id);
    const t = this.now();
    this.sessions.set(key, {
      key, createdAt: t, lastSeen: t, expiresAt: t + this.ttlMs, issuedAt: t,
      epoch, ip: meta.ip, userAgent: meta.userAgent,
    });
    this.save();
    return { id, key };
  }

  check(id: string, epoch: number): SessionCheck {
    if (typeof id !== 'string' || !ID_RE.test(id)) return { valid: false };
    const key = sha256(id);
    const rec = this.sessions.get(key);
    if (!rec) return { valid: false };
    const t = this.now();
    if (rec.expiresAt <= t) {
      this.sessions.delete(key); // persisted away on the next write
      return { valid: false };
    }
    if (rec.epoch !== epoch) return { valid: false };
    rec.lastSeen = t;
    rec.expiresAt = t + this.ttlMs;
    const refresh = t - rec.issuedAt > REFRESH_AFTER_MS;
    if (refresh) {
      rec.issuedAt = t;
      // Sliding expiry and lastSeen are only persisted on refresh to avoid a write per request.
      try { this.save(); } catch { /* keep the in-memory session usable */ }
    }
    return { valid: true, key, refresh };
  }

  revoke(id: string): void {
    if (typeof id !== 'string') return;
    if (this.sessions.delete(sha256(id))) this.save();
  }

  private load(): void {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return; // missing, empty or malformed -> no sessions
    }
    const list = (raw as { sessions?: unknown } | null)?.sessions;
    if (!Array.isArray(list)) return;
    const t = this.now();
    for (const r of list) {
      if (isRecord(r) && r.expiresAt > t) this.sessions.set(r.key, r);
    }
  }

  private save(): void {
    const t = this.now();
    for (const [k, r] of this.sessions) if (r.expiresAt <= t) this.sessions.delete(k);
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      // Mode 0o600 has no effect on Windows.
      fs.writeFileSync(tmp, JSON.stringify({ sessions: [...this.sessions.values()] }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
  }
}
