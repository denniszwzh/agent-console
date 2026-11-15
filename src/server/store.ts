import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentKind, ReviewUnit } from '../shared/types.js';
import { dataDir } from './paths.js';

export class UnitStore {
  private unitsDir(): string {
    const dir = path.join(dataDir(), 'units');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Atomic write: temp file in the same directory, then rename. */
  save(u: ReviewUnit): void {
    const dir = this.unitsDir();
    const final = path.join(dir, `${u.id}.json`);
    const tmp = path.join(dir, `.${u.id}.${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(u));
    fs.renameSync(tmp, final);
  }

  get(id: string): ReviewUnit | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.unitsDir(), `${id}.json`), 'utf8')) as ReviewUnit;
    } catch {
      return null;
    }
  }

  private all(): ReviewUnit[] {
    const dir = this.unitsDir();
    const units: ReviewUnit[] = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const u = this.get(name.slice(0, -'.json'.length));
      if (u) units.push(u);
    }
    return units;
  }

  listBySession(sessionId: string): ReviewUnit[] {
    return this.all()
      .filter((u) => u.sessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  latestForSession(sessionId: string): ReviewUnit | null {
    const units = this.listBySession(sessionId);
    return units.length ? units[units.length - 1] : null;
  }

  listSessions(): { sessionId: string; agent: AgentKind; cwd: string; lastActivity: string }[] {
    const bySession = new Map<string, { sessionId: string; agent: AgentKind; cwd: string; lastActivity: string }>();
    for (const u of this.all()) {
      const cur = bySession.get(u.sessionId);
      if (!cur || u.createdAt > cur.lastActivity) {
        bySession.set(u.sessionId, { sessionId: u.sessionId, agent: u.agent, cwd: u.cwd, lastActivity: u.createdAt });
      }
    }
    return [...bySession.values()].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  }
}
