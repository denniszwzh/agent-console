import { useState } from 'react';
import type { ReviewUnit } from '../../shared/types.js';
import type { SessionSummary } from '../api.js';
import { groupSessions, readCollapsedGroups, writeCollapsedGroups } from '../grouping.js';
import { formatTime, sessionTitle } from '../labels.js';
import { answeringThreadCount } from '../unit-context.js';

interface Props {
  sessions: SessionSummary[];
  /** Session ids whose main session is working on a turn right now. */
  responding?: ReadonlySet<string>;
  unitsBySession: Record<string, ReviewUnit[] | undefined>;
  selectedSession: string | null;
  onSelect(sessionId: string): void;
  /** Hides the sidebar (collapse when docked, close when shown as a drawer). */
  onHide?(): void;
  /** Rendered as an overlay drawer (portrait / narrow layout). */
  drawer?: boolean;
  /** Present on the password-protected entry: shows a Sign out button at the bottom. */
  onSignOut?(): void;
}

export function Sidebar({ sessions, responding, unitsBySession, selectedSession, onSelect, onHide, drawer, onSignOut }: Props) {
  const [collapsed, setCollapsed] = useState(readCollapsedGroups);
  // Units still loading count as replied, so the groups do not reorder while the page loads.
  const groups = groupSessions(sessions, (id) => {
    const units = unitsBySession[id];
    return units === undefined || units.length > 0;
  });

  const toggle = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeCollapsedGroups(next);
      return next;
    });
  };

  return (
    <aside className={`sidebar${drawer ? ' sidebar-drawer' : ''}`}>
      <div className="sidebar-title">
        <span>Agent Console</span>
        {onHide && (
          <button type="button" className="btn ghost small sidebar-hide" aria-label="Hide sidebar" title="Hide sidebar" onClick={onHide}>
            «
          </button>
        )}
      </div>
      {sessions.length === 0 && (
        <p className="sidebar-empty">No replies yet. Talk to Claude Code or Codex in the terminal and the replies show up here.</p>
      )}
      <ul className="project-list">
        {groups.map((g) => {
          const isOpen = !collapsed.has(g.key);
          const open = g.sessions.reduce((n, s) => n + answeringThreadCount(unitsBySession[s.sessionId]), 0);
          return (
            <li key={g.key} className="project-group">
              <button type="button" className="project-head" aria-expanded={isOpen} title={g.root} onClick={() => toggle(g.key)}>
                <span className="project-caret" aria-hidden="true">
                  {isOpen ? '▾' : '▸'}
                </span>
                <span className="project-name">{g.name}</span>
                {open > 0 && <span className="open-count">{open} answering</span>}
              </button>
              {isOpen && (
                <ul className="session-list">
                  {g.sessions.map((s) => {
                    const sessionOpen = answeringThreadCount(unitsBySession[s.sessionId]);
                    const selected = s.sessionId === selectedSession;
                    const worktree = s.project?.worktree;
                    return (
                      <li key={s.sessionId} className={`session${selected ? ' selected' : ''}`}>
                        <button
                          type="button"
                          className="session-btn"
                          title={`${sessionTitle(s)}\n${s.cwd}\n${s.sessionId}`}
                          aria-current={selected ? 'true' : undefined}
                          onClick={() => onSelect(s.sessionId)}
                        >
                          <span className={`agent-dot agent-${s.agent}`} aria-hidden="true" />
                          <span className="session-name">
                            <span className={`session-project${s.titleSource === 'prompt' ? ' untitled' : ''}`}>{sessionTitle(s)}</span>
                            {worktree && <span className="session-meta session-worktree">worktree: {worktree}</span>}
                            <span className="session-meta">
                              {s.agent} · {formatTime(s.lastActivity)}
                            </span>
                            {/* Badges sit under the name so they never squeeze it. */}
                            {(responding?.has(s.sessionId) || sessionOpen > 0) && (
                              <span className="session-badges">
                                {responding?.has(s.sessionId) && (
                                  <span className="responding-badge" title="Main session is responding">
                                    <span className="responding-dot" aria-hidden="true" />
                                    Responding
                                  </span>
                                )}
                                {sessionOpen > 0 && (
                                  <span className="open-count" title={`${sessionOpen} ${sessionOpen === 1 ? 'thread' : 'threads'} being answered`}>
                                    {sessionOpen} answering
                                  </span>
                                )}
                              </span>
                            )}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {onSignOut && (
        <div className="sidebar-foot">
          <button type="button" className="btn ghost small" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      )}
    </aside>
  );
}
