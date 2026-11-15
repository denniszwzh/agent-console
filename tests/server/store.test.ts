import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UnitStore } from '../../src/server/store.js';
import { ensureToken } from '../../src/server/paths.js';
import type { ReviewUnit } from '../../src/shared/types.js';

let home: string;
const prevHome = process.env.AGENT_CONSOLE_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-console-test-'));
  process.env.AGENT_CONSOLE_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.AGENT_CONSOLE_HOME;
  else process.env.AGENT_CONSOLE_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function makeUnit(id: string, sessionId: string, createdAt: string): ReviewUnit {
  return {
    id,
    agent: 'claude',
    sessionId,
    cwd: 'C:/work',
    createdAt,
    reply: { id: 'reply', kind: 'reply', content: 'hello', blocks: [] },
    files: [],
    threads: [],
    status: 'open',
    delivered: false,
    warnings: [],
  };
}

describe('UnitStore', () => {
  it('saves and reloads a unit', () => {
    const unit = makeUnit('u1', 's1', '2026-01-01T00:00:00.000Z');
    new UnitStore().save(unit);
    expect(new UnitStore().get('u1')).toEqual(unit);
  });

  it('latestForSession returns the newest by createdAt', () => {
    const store = new UnitStore();
    store.save(makeUnit('old', 's1', '2026-01-01T00:00:00.000Z'));
    store.save(makeUnit('new', 's1', '2026-02-01T00:00:00.000Z'));
    store.save(makeUnit('other', 's2', '2026-03-01T00:00:00.000Z'));
    expect(store.latestForSession('s1')?.id).toBe('new');
  });

  it('listSessions aggregates per session, newest first', () => {
    const store = new UnitStore();
    store.save(makeUnit('a1', 'sa', '2026-01-01T00:00:00.000Z'));
    store.save(makeUnit('a2', 'sa', '2026-04-01T00:00:00.000Z'));
    store.save(makeUnit('b1', 'sb', '2026-02-01T00:00:00.000Z'));
    expect(store.listSessions().map((s) => [s.sessionId, s.lastActivity])).toEqual([
      ['sa', '2026-04-01T00:00:00.000Z'],
      ['sb', '2026-02-01T00:00:00.000Z'],
    ]);
  });
});

describe('ensureToken', () => {
  it('ensureToken is stable', () => {
    const a = ensureToken();
    const b = ensureToken();
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });
});
