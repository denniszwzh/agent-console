import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReviewUnit, SessionActivity, SessionSummary } from '../../shared/types.js';
import { UNIT_STATUS_LABELS, formatRelative, formatTime, lastChanged, sessionTitle } from '../labels.js';
import { answeringThreadCount, openThreadCount } from '../unit-context.js';
import { formatElapsed, useNow } from './Responding.js';

/**
 * Hold-to-show switcher state: Alt+S opens it, and it stays open while Alt is held.
 * Releasing Alt, Escape, or the window losing focus (e.g. Alt+Tab away) closes it. So does any later
 * key or mouse event that shows Alt is no longer held, in case the Alt release itself was missed.
 */
export function useHoldSwitcher(): { open: boolean; close(): void } {
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const set = useCallback((v: boolean) => {
    openRef.current = v;
    setOpen(v);
  }, []);

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (openRef.current && e.key === 'Escape') {
        e.preventDefault();
        set(false);
      } else if (e.altKey && e.code === 'KeyS' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        set(true);
      } else if (openRef.current && !e.altKey) {
        set(false);
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (!openRef.current || (e.key !== 'Alt' && e.altKey)) return;
      // Keeps Windows browsers from moving focus to their menu on the Alt release.
      if (e.key === 'Alt') e.preventDefault();
      set(false);
    };
    const onMouse = (e: MouseEvent) => {
      if (openRef.current && !e.altKey) set(false);
    };
    const onBlur = () => set(false);
    // Capture phase: a focused text box must not swallow the shortcut.
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('mousemove', onMouse, true);
    window.addEventListener('mousedown', onMouse, true);
    return () => {
      window.removeEventListener('mousemove', onMouse, true);
      window.removeEventListener('mousedown', onMouse, true);
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [set]);

  return { open, close: useCallback(() => set(false), [set]) };
}

function Elapsed({ since }: { since: string }) {
  const now = useNow(1000);
  return <>{formatElapsed(since, now)}</>;
}

interface Props {
  sessions: SessionSummary[];
  unitsBySession: Record<string, ReviewUnit[] | undefined>;
  activity: SessionActivity[];
  selectedSession: string | null;
  onSelect(sessionId: string): void;
}

export function SessionSwitcher({ sessions, unitsBySession, activity, selectedSession, onSelect }: Props) {
  const now = useNow(60_000);
  const responding = new Map(activity.map((a) => [a.sessionId, a]));
  const sorted = [...sessions].sort((a, b) => lastChanged(b).localeCompare(lastChanged(a)));

  return (
    <div className="switcher-backdrop">
      <div className="switcher" role="dialog" aria-label="切換對話">
        <div className="switcher-head">
          <strong>切換對話</strong>
          <span className="hint">按著 Alt 點選對話；放開 Alt 關閉</span>
        </div>
        {sorted.length === 0 && <p className="switcher-empty">還沒有任何對話。</p>}
        <ul className="switcher-list">
          {sorted.map((s) => {
            const units = unitsBySession[s.sessionId];
            const latest = units?.[units.length - 1];
            const created = s.createdAt ?? units?.[0]?.createdAt;
            const act = responding.get(s.sessionId);
            const answering = answeringThreadCount(units);
            const open = openThreadCount(units);
            const current = s.sessionId === selectedSession;
            return (
              <li key={s.sessionId}>
                <button
                  type="button"
                  className={`switcher-item${current ? ' current' : ''}`}
                  aria-current={current ? 'true' : undefined}
                  onClick={() => onSelect(s.sessionId)}
                >
                  <span className="switcher-line">
                    <span className={`agent-dot agent-${s.agent}`} aria-hidden="true" />
                    <span className={`switcher-title${s.titleSource === 'prompt' ? ' untitled' : ''}`}>{sessionTitle(s)}</span>
                    <span className="switcher-badges">
                      {act && (
                        <span className="responding-badge">
                          <span className="responding-dot" aria-hidden="true" />
                          回應中 <Elapsed since={act.since} />
                        </span>
                      )}
                      {answering > 0 && <span className="switcher-answering">{answering} 個問題串回答中</span>}
                      {open > 0 && <span className="open-count">{open} 未結</span>}
                      {latest && <span className={`switcher-status status-${latest.status}`}>{UNIT_STATUS_LABELS[latest.status]}</span>}
                    </span>
                  </span>
                  <span className="switcher-path">
                    {s.agent} · {s.cwd}
                  </span>
                  <span className="switcher-times">
                    {created && <>建立 {formatTime(created)} · </>}更改 {formatRelative(lastChanged(s), now)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
