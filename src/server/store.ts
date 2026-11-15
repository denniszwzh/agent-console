import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isSafeId } from '../shared/ids.js';
import type { AgentKind, ReviewUnit, SessionSummary } from '../shared/types.js';
import { dataDir } from './paths.js';

/** What the index keeps per unit: enough to list and order without reading the file. */
interface IndexEntry {
  sessionId: string;
  createdAt: string;
  agent: AgentKind;
  cwd: string;
}

export class UnitStore {
  /** unitId -> entry; built once from disk, then maintained by save(). */
  private index = new Map<string, IndexEntry>();
  /** sessionId -> unitIds */
  private bySession = new Map<string, Set<string>>();

  constructor() {
    const dir = this.unitsDir();
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      try {
        const u = this.get(id);
        if (u) this.indexUnit(u);
      } catch (e) {
        console.warn(`[store] skipping unreadable unit file ${name}: ${(e as Error).message}`);
      }
    }
  }

  private unitsDir(): string {
    const dir = path.join(dataDir(), 'units');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private indexUnit(u: ReviewUnit): void {
    const prev = this.index.get(u.id);
    if (prev && prev.sessionId !== u.sessionId) this.bySession.get(prev.sessionId)?.delete(u.id);
    this.index.set(u.id, { sessionId: u.sessionId, createdAt: u.createdAt, agent: u.agent, cwd: u.cwd });
    let ids = this.bySession.get(u.sessionId);
    if (!ids) this.bySession.set(u.sessionId, (ids = new Set()));
    ids.add(u.id);
  }

  /** Atomic write: temp file in the same directory, then rename. */
  save(u: ReviewUnit): void {
    // The id becomes a file name: never let it climb out of the units directory.
    if (!isSafeId(u.id)) throw new Error(`invalid unit id: ${JSON.stringify(u.id)}`);
    const dir = this.unitsDir();
    const final = path.join(dir, `${u.id}.json`);
    const tmp = path.join(dir, `.${u.id}.${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(u));
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, final);
        this.indexUnit(u);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if ((code === 'EPERM' || code === 'EBUSY') && attempt < 5) {
          // Windows may briefly lock the target (AV, OneDrive); back off and retry.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
          continue;
        }
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        throw e;
      }
    }
  }

  get(id: string): ReviewUnit | null {
    if (!isSafeId(id)) return null;
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(this.unitsDir(), `${id}.json`), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    // Corrupt JSON is surfaced to the caller rather than hidden as "not found".
    return JSON.parse(raw) as ReviewUnit;
  }

  /** Reads one indexed unit for a list; an unreadable file is skipped with a warning. */
  private readForList(id: string): ReviewUnit | null {
    try {
      return this.get(id);
    } catch (e) {
      console.warn(`[store] skipping unreadable unit file ${id}.json: ${(e as Error).message}`);
      return null;
    }
  }

  private sessionIdsByAge(sessionId: string): string[] {
    const ids = [...(this.bySession.get(sessionId) ?? [])];
    return ids.sort((a, b) => (this.index.get(a)?.createdAt ?? '').localeCompare(this.index.get(b)?.createdAt ?? ''));
  }

  listBySession(sessionId: string): ReviewUnit[] {
    const units: ReviewUnit[] = [];
    for (const id of this.sessionIdsByAge(sessionId)) {
      const u = this.readForList(id);
      if (u) units.push(u);
    }
    return units;
  }

  latestForSession(sessionId: string): ReviewUnit | null {
    const ids = this.sessionIdsByAge(sessionId);
    for (let i = ids.length - 1; i >= 0; i--) {
      const u = this.readForList(ids[i]);
      if (u) return u;
    }
    return null;
  }

  listSessions(): SessionSummary[] {
    const bySession = new Map<string, SessionSummary>();
    for (const e of this.index.values()) {
      const cur = bySession.get(e.sessionId);
      if (!cur || e.createdAt > cur.lastActivity) {
        bySession.set(e.sessionId, { sessionId: e.sessionId, agent: e.agent, cwd: e.cwd, lastActivity: e.createdAt });
      }
    }
    return [...bySession.values()].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  }
}
