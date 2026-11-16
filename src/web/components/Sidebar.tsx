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
}

export function Sidebar({ sessions, responding, unitsBySession, selectedSession, onSelect, onHide, drawer }: Props) {
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
          <button type="button" className="btn ghost small sidebar-hide" aria-label="隱藏側欄" title="隱藏側欄" onClick={onHide}>
            «
          </button>
        )}
      </div>
      {sessions.length === 0 && (
        <p className="sidebar-empty">還沒有任何回覆。在 terminal 跟 agent 對話後，回覆會出現在這裡。</p>
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
                {open > 0 && <span className="open-count">{open} 串回答中</span>}
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
                          title={`${s.cwd}\n${s.sessionId}`}
                          aria-current={selected ? 'true' : undefined}
                          onClick={() => onSelect(s.sessionId)}
                        >
                          <span className={`agent-dot agent-${s.agent}`} aria-hidden="true" />
                          <span className="session-name">
                            <span className={`session-project${s.titleSource === 'prompt' ? ' untitled' : ''}`}>{sessionTitle(s)}</span>
                            <span className="session-meta">
                              {worktree ? `worktree: ${worktree} · ` : ''}
                              {s.agent} · {formatTime(s.lastActivity)}
                            </span>
                          </span>
                          {responding?.has(s.sessionId) && (
                            <span className="responding-badge" title="主對話正在回應">
                              <span className="responding-dot" aria-hidden="true" />
                              回應中
                            </span>
                          )}
                          {sessionOpen > 0 && (
                            <span className="open-count" title={`${sessionOpen} 個問題串正在回答`}>
                              {sessionOpen} 串回答中
                            </span>
                          )}
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
    </aside>
  );
}
