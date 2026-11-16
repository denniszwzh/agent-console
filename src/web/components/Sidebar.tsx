import type { ReviewUnit } from '../../shared/types.js';
import type { SessionSummary } from '../api.js';
import { UNIT_STATUS_LABELS, basename, firstLine, formatTime, lastChanged, sessionTitle } from '../labels.js';
import { openThreadCount } from '../unit-context.js';

interface Props {
  sessions: SessionSummary[];
  /** Session ids whose main session is working on a turn right now. */
  responding?: ReadonlySet<string>;
  unitsBySession: Record<string, ReviewUnit[] | undefined>;
  selectedSession: string | null;
  selectedUnit: string | null;
  onSelect(sessionId: string, unitId: string | null): void;
  /** Hides the sidebar (collapse when docked, close when shown as a drawer). */
  onHide?(): void;
  /** Rendered as an overlay drawer (portrait / narrow layout). */
  drawer?: boolean;
}

export function Sidebar({ sessions, responding, unitsBySession, selectedSession, selectedUnit, onSelect, onHide, drawer }: Props) {
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
                  <span className={`session-project${s.titleSource === 'prompt' ? ' untitled' : ''}`}>{sessionTitle(s)}</span>
                  <span className="session-meta">
                    {basename(s.cwd)} · {s.agent} · {formatTime(lastChanged(s))}
                  </span>
                </span>
                {responding?.has(s.sessionId) && (
                  <span className="responding-badge" title="主對話正在回應">
                    <span className="responding-dot" aria-hidden="true" />
                    回應中
                  </span>
                )}
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
