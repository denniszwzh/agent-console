import type { ReviewUnit } from '../../shared/types.js';
import type { SessionSummary } from '../api.js';
import { UNIT_STATUS_LABELS, basename, firstLine, formatTime } from '../labels.js';
import { isOpenThread } from '../unit-context.js';

interface Props {
  sessions: SessionSummary[];
  unitsBySession: Record<string, ReviewUnit[] | undefined>;
  selectedSession: string | null;
  selectedUnit: string | null;
  onSelect(sessionId: string, unitId: string | null): void;
}

function openThreadCount(units: ReviewUnit[] | undefined): number {
  if (!units) return 0;
  return units
    .filter((u) => u.status === 'open')
    .reduce((n, u) => n + u.threads.filter(isOpenThread).length, 0);
}

export function Sidebar({ sessions, unitsBySession, selectedSession, selectedUnit, onSelect }: Props) {
  return (
    <aside className="sidebar">
      <div className="sidebar-title">Agent Console</div>
      {sessions.length === 0 && (
        <p className="sidebar-empty">還沒有任何回覆。在 terminal 跟 agent 對話後，回覆會出現在這裡。</p>
      )}
      <ul className="session-list">
        {sessions.map((s) => {
          const units = unitsBySession[s.sessionId];
          const open = openThreadCount(units);
          const selected = s.sessionId === selectedSession;
          const latest = units?.[units.length - 1];
          return (
            <li key={s.sessionId} className={`session${selected ? ' selected' : ''}`}>
              <button
                type="button"
                className="session-btn"
                title={`${s.cwd}\n${s.sessionId}`}
                onClick={() => onSelect(s.sessionId, latest?.id ?? null)}
              >
                <span className={`agent-dot agent-${s.agent}`} aria-hidden="true" />
                <span className="session-name">
                  <span className="session-project">{basename(s.cwd)}</span>
                  <span className="session-meta">
                    {s.agent} · {formatTime(s.lastActivity)}
                  </span>
                </span>
                {open > 0 && (
                  <span className="open-count" title={`${open} 個未結束問題串`}>
                    {open} 未結
                  </span>
                )}
              </button>
              {selected && units && units.length > 0 && (
                <ol className="unit-history">
                  {[...units].reverse().map((u) => (
                    <li key={u.id}>
                      <button
                        type="button"
                        className={`unit-btn${u.id === selectedUnit ? ' selected' : ''}`}
                        onClick={() => onSelect(s.sessionId, u.id)}
                      >
                        <span className="unit-btn-line">{firstLine(u.reply.content, 40) || '（空白回覆）'}</span>
                        <span className="unit-btn-meta">
                          {formatTime(u.createdAt)} · {UNIT_STATUS_LABELS[u.status]}
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
