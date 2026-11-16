import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('UnitStore edge cases', () => {
  it('saving the same id twice overwrites', () => {
    const store = new UnitStore();
    store.save(makeUnit('u1', 's1', '2026-01-01T00:00:00.000Z'));
    store.save({ ...makeUnit('u1', 's1', '2026-01-01T00:00:00.000Z'), status: 'submitted' });
    expect(store.get('u1')?.status).toBe('submitted');
    expect(fs.readdirSync(path.join(home, 'units'))).toEqual(['u1.json']);
  });

  it('get returns null for a missing unit and throws on corrupt JSON', () => {
    const store = new UnitStore();
    expect(store.get('nope')).toBeNull();
    fs.writeFileSync(path.join(home, 'units', 'bad.json'), '{not json');
    expect(() => store.get('bad')).toThrow();
  });

  it('list methods skip corrupt files with a warning (at index build)', () => {
    new UnitStore().save(makeUnit('ok', 's1', '2026-01-01T00:00:00.000Z'));
    fs.writeFileSync(path.join(home, 'units', 'bad.json'), '{not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new UnitStore();
    expect(store.listBySession('s1').map((u) => u.id)).toEqual(['ok']);
    expect(store.listSessions()).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bad.json'));
    warn.mockRestore();
  });

  it('recreates a missing data dir', () => {
    const store = new UnitStore();
    fs.rmSync(home, { recursive: true, force: true });
    store.save(makeUnit('u1', 's1', '2026-01-01T00:00:00.000Z'));
    expect(store.get('u1')?.id).toBe('u1');
  });
});

describe('ensureToken', () => {
  it('ensureToken is stable', () => {
    const a = ensureToken();
    const b = ensureToken();
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it('regenerates an empty token file', () => {
    fs.writeFileSync(path.join(home, 'token'), '');
    expect(ensureToken()).toHaveLength(64);
  });

  it('rethrows non-ENOENT read errors instead of overwriting', () => {
    fs.mkdirSync(path.join(home, 'token'));
    expect(() => ensureToken()).toThrow();
    expect(fs.statSync(path.join(home, 'token')).isDirectory()).toBe(true);
  });
});

describe('UnitStore index (final review item 2 / R-F3)', () => {
  it('rebuilds the session index from disk at construction (survives a restart)', () => {
    const a = new UnitStore();
    a.save(makeUnit('u1', 's1', '2026-01-01T00:00:00.000Z'));
    a.save(makeUnit('u2', 's1', '2026-03-01T00:00:00.000Z'));
    a.save(makeUnit('u3', 's2', '2026-02-01T00:00:00.000Z'));
    const b = new UnitStore();
    expect(b.listBySession('s1').map((u) => u.id)).toEqual(['u1', 'u2']);
    expect(b.latestForSession('s1')?.id).toBe('u2');
    expect(b.listSessions().map((s) => s.sessionId)).toEqual(['s1', 's2']);
  });

  it('save keeps the index current and list calls never scan the directory', () => {
    const store = new UnitStore();
    const readdir = vi.spyOn(fs, 'readdirSync');
    store.save(makeUnit('u1', 's1', '2026-01-01T00:00:00.000Z'));
    store.save(makeUnit('u2', 's2', '2026-02-01T00:00:00.000Z'));
    expect(store.listBySession('s1').map((u) => u.id)).toEqual(['u1']);
    expect(store.latestForSession('s2')?.id).toBe('u2');
    expect(store.listSessions().map((s) => [s.sessionId, s.lastActivity])).toEqual([
      ['s2', '2026-02-01T00:00:00.000Z'],
      ['s1', '2026-01-01T00:00:00.000Z'],
    ]);
    expect(readdir).not.toHaveBeenCalled();
    readdir.mockRestore();
  });
});

describe('UnitStore unit id safety (final review item 5)', () => {
  it('get returns null and save throws for ids that are not safe file names', () => {
    const store = new UnitStore();
    fs.writeFileSync(path.join(home, 'outside.json'), JSON.stringify(makeUnit('outside', 's1', '2026-01-01T00:00:00.000Z')));
    for (const id of ['../outside', '..\\outside', '.hidden', '', 'a/b']) {
      expect(store.get(id)).toBeNull();
      expect(() => store.save(makeUnit(id, 's1', '2026-01-01T00:00:00.000Z'))).toThrow(/unit id/);
    }
  });
});

describe('UnitStore transcript paths', () => {
  it('remembers the transcript path of the latest unit', () => {
    const store = new UnitStore();
    store.save({ ...makeUnit('u1', 's1', '2026-01-01T00:00:00.000Z'), transcriptPath: 'C:\a.jsonl' });
    store.save({ ...makeUnit('u2', 's1', '2026-01-02T00:00:00.000Z'), transcriptPath: 'C:\b.jsonl' });
    store.save(makeUnit('u3', 's2', '2026-01-03T00:00:00.000Z'));
    expect(store.transcriptPathFor('s1')).toBe('C:\b.jsonl');
    expect(store.transcriptPathFor('s2')).toBeUndefined();
    expect(new UnitStore().transcriptPathFor('s1')).toBe('C:\b.jsonl');
  });
});
