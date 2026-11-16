import { describe, expect, it } from 'vitest';
import { groupSessions } from '../../src/web/grouping.js';
import type { SessionSummary } from '../../src/shared/types.js';

const s = (sessionId: string, lastActivity: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  sessionId,
  agent: 'claude',
  cwd: 'C:\\p\\repo',
  lastActivity,
  ...over,
});
const repo = { key: 'c:\\p\\repo', root: 'C:\\p\\repo' };
const other = { key: 'c:\\p\\other', root: 'C:\\p\\other' };
const all = () => true;

describe('groupSessions', () => {
  it('groups worktree sessions under their repository', () => {
    const groups = groupSessions(
      [
        s('a', '2026-11-16T03:00:00.000Z', { cwd: 'C:\\p\\repo\\.claude\\worktrees\\x', project: { ...repo, worktree: 'x' } }),
        s('b', '2026-11-16T02:00:00.000Z', { project: repo }),
      ],
      all,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: repo.key, root: repo.root, name: 'repo' });
    expect(groups[0].sessions.map((x) => x.sessionId)).toEqual(['a', 'b']);
  });

  it('orders groups by newest reply and puts responding-only sessions first', () => {
    const groups = groupSessions(
      [
        s('fresh-in-repo', '2026-11-16T09:00:00.000Z', { project: repo }),
        s('o1', '2026-11-16T05:00:00.000Z', { cwd: 'C:\\p\\other', project: other }),
        s('r1', '2026-11-16T04:00:00.000Z', { project: repo }),
        s('fresh-new', '2026-11-16T09:30:00.000Z', { cwd: 'C:\\p\\new', project: { key: 'c:\\p\\new', root: 'C:\\p\\new' } }),
      ],
      (id) => !id.startsWith('fresh'),
    );
    expect(groups.map((g) => g.name)).toEqual(['new', 'other', 'repo']);
    expect(groups[2].sessions.map((x) => x.sessionId)).toEqual(['fresh-in-repo', 'r1']);
  });

  it('keeps the order while units are still loading', () => {
    const list = [s('a', '2026-11-16T05:00:00.000Z', { project: repo }), s('b', '2026-11-16T04:00:00.000Z', { cwd: 'C:\\p\\other', project: other })];
    expect(groupSessions(list, all).map((g) => g.name)).toEqual(['repo', 'other']);
  });

  it('falls back to cwd without project', () => {
    const groups = groupSessions([s('a', '2026-11-16T05:00:00.000Z', { cwd: 'C:\\p\\loose' }), s('b', '2026-11-16T04:00:00.000Z', { cwd: 'C:/p/loose' })], all);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: 'C:/p/loose', name: 'loose' });
  });

  it('labels an empty cwd', () => {
    expect(groupSessions([s('a', '2026-11-16T05:00:00.000Z', { cwd: '' })], all)[0].name).toBe('（未知資料夾）');
  });
});
