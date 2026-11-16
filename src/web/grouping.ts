import type { SessionSummary } from '../shared/types.js';
import { basename } from './labels.js';

export interface ProjectGroup {
  key: string;
  root: string;
  name: string;
  sessions: SessionSummary[];
}

/** localStorage key holding the keys of collapsed project groups. */
export const GROUPS_COLLAPSED_KEY = 'agent-console.groups-collapsed';

const UNKNOWN_FOLDER = '（未知資料夾）';

/**
 * Sessions grouped by project (git worktrees under their main repository).
 * Groups are ordered by their newest reply; a group whose sessions have no reply yet comes first.
 * Within a group, sessions without a reply come first, then the input order (newest reply first).
 * Only reply times count, so the list does not move while sessions are responding.
 */
export function groupSessions(sessions: SessionSummary[], hasReplies: (sessionId: string) => boolean): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup & { newest: string | null }>();
  for (const s of sessions) {
    const root = s.project?.root ?? s.cwd;
    const key = s.project?.key ?? s.cwd.replace(/\\/g, '/');
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, root, name: root ? basename(root) : UNKNOWN_FOLDER, sessions: [], newest: null }));
    g.sessions.push(s);
    if (hasReplies(s.sessionId) && (g.newest === null || s.lastActivity > g.newest)) g.newest = s.lastActivity;
  }
  const list = [...groups.values()];
  for (const g of list) {
    const waiting = g.sessions.filter((s) => !hasReplies(s.sessionId));
    g.sessions = [...waiting, ...g.sessions.filter((s) => hasReplies(s.sessionId))];
  }
  // Stable sort: groups without replies keep their relative order on top.
  list.sort((a, b) => (a.newest === null ? (b.newest === null ? 0 : -1) : b.newest === null ? 1 : b.newest.localeCompare(a.newest)));
  return list.map(({ newest: _newest, ...g }) => g);
}

export function readCollapsedGroups(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(GROUPS_COLLAPSED_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

export function writeCollapsedGroups(keys: Set<string>): void {
  try {
    localStorage.setItem(GROUPS_COLLAPSED_KEY, JSON.stringify([...keys]));
  } catch {
    // Not remembered; harmless.
  }
}
