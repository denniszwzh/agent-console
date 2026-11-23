import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../paths.js';
import { LoginLimiter, normaliseIp } from './limiter.js';
import { authFilePath, readAuthFile, verifyCredentials, type AuthFile } from './password.js';
import { SessionStore, type SessionMeta } from './sessions.js';

export type LoginResult =
  | { ok: true; id: string; username: string }
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'locked'; retryAfterSec: number };
export type AuthCheck = { ok: false } | { ok: true; key: string; username: string; refresh: boolean };

type RevokeListener = (keys: 'all' | string[]) => void;

const ID_RE = /^[0-9a-f]{64}$/;
export class RemoteAuth {
  private readonly store: SessionStore;
  private readonly limiter: LoginLimiter;
  private readonly failureDelayMs: number;
  private readonly listeners = new Set<RevokeListener>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private watcher: fs.FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;

  // mtime+size(+inode) cache of auth.json so a request does not re-parse it every time.
  private cacheStamp = '';
  private cached: AuthFile | null = null;
  private lastEpoch: number | null;

  constructor(opts: { sessionDays: number; now?: () => number; pollMs?: number; failureDelayMs?: number }) {
    const dir = dataDir();
    this.store = new SessionStore({ file: path.join(dir, 'sessions.json'), sessionDays: opts.sessionDays, now: opts.now });
    this.limiter = new LoginLimiter(opts.now);
    this.failureDelayMs = opts.failureDelayMs ?? 1000;
    this.lastEpoch = this.current()?.sessionEpoch ?? null;

    try {
      this.watcher = fs.watch(dir, (_event, name) => {
        if (name === null || name === undefined || String(name) === 'auth.json') this.current();
      });
      this.watcher.on('error', () => {
        // Rely on the poll when the watcher breaks.
        try { this.watcher?.close(); } catch { /* ignore */ }
        this.watcher = null;
      });
      this.watcher.unref?.();
    } catch {
      this.watcher = null;
    }
    this.timer = setInterval(() => this.current(), opts.pollMs ?? 5000);
    this.timer.unref();
  }

  hasPassword(): boolean {
    return this.current() !== null;
  }

  async login(username: string, password: string, meta: SessionMeta): Promise<LoginResult> {
    // Attempts from one IP run one after another so parallel guesses cannot all pass the
    // lock check before any failure is counted. The failure delay is served outside the queue.
    const key = normaliseIp(meta.ip);
    const prev = this.chains.get(key) ?? Promise.resolve();
    const run = prev.then(() => this.attempt(username, password, meta));
    const tail = run.catch(() => undefined);
    this.chains.set(key, tail);
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    const { result, delay } = await run;
    if (delay && this.failureDelayMs > 0) await new Promise((r) => setTimeout(r, this.failureDelayMs));
    return result;
  }

  private async attempt(
    username: string,
    password: string,
    meta: SessionMeta,
  ): Promise<{ result: LoginResult; delay: boolean }> {
    const lock = this.limiter.check(meta.ip);
    if (lock.locked) {
      return { result: { ok: false, reason: 'locked', retryAfterSec: lock.retryAfterSec }, delay: false };
    }
    const auth = this.current();
    // With no auth file this still burns a full scrypt run and always yields false.
    const ok = await verifyCredentials(auth, username, password);
    if (!ok || !auth) {
      this.limiter.fail(meta.ip);
      return { result: { ok: false, reason: 'invalid' }, delay: true };
    }
    this.limiter.succeed(meta.ip);
    const { id } = this.store.create(auth.sessionEpoch, meta);
    return { result: { ok: true, id, username: auth.username }, delay: false };
  }

  check(id: string | null): AuthCheck {
    const auth = this.current();
    if (!auth || !id) return { ok: false };
    const res = this.store.check(id, auth.sessionEpoch);
    if (!res.valid) return { ok: false };
    return { ok: true, key: res.key, username: auth.username, refresh: res.refresh };
  }

  /** Whether the session is still valid, without extending it (for long-lived streams). */
  peek(id: string | null): boolean {
    const auth = this.current();
    if (!auth || !id) return false;
    return this.store.isValid(id, auth.sessionEpoch);
  }

  logout(id: string): string | null {
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    if (!this.store.revoke(id)) return null;
    const key = crypto.createHash('sha256').update(id).digest('hex');
    this.emit([key]);
    return key;
  }

  onRevoke(listener: RevokeListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try { this.watcher?.close(); } catch { /* ignore */ }
    this.watcher = null;
    this.listeners.clear();
  }

  private emit(keys: 'all' | string[]): void {
    for (const l of [...this.listeners]) {
      try { l(keys); } catch { /* a bad listener must not break auth */ }
    }
  }

  // Reads auth.json through the stat cache and emits 'all' when the epoch (or its presence) changed.
  private current(): AuthFile | null {
    let stamp = 'missing';
    try {
      const st = fs.statSync(authFilePath());
      stamp = `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch { /* missing */ }
    if (stamp !== this.cacheStamp) {
      this.cached = stamp === 'missing' ? null : readAuthFile();
      // A failed read of an existing file may be transient (EMFILE/EBUSY, half-written):
      // leave the stamp unset so the next call re-reads instead of caching the null.
      this.cacheStamp = stamp !== 'missing' && this.cached === null ? '' : stamp;
    }
    const epoch = this.cached?.sessionEpoch ?? null;
    if (epoch !== this.lastEpoch) {
      this.lastEpoch = epoch;
      this.emit('all');
    }
    return this.cached;
  }
}
