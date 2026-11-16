import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReviewUnit } from '../shared/types.js';
import { ApiError, api, subscribeEvents, type SessionActivity, type SessionSummary } from './api.js';
import { RespondingBanner } from './components/Responding.js';
import { SessionSwitcher, useHoldSwitcher } from './components/SessionSwitcher.js';
import { Sidebar } from './components/Sidebar.js';
import { UnitView } from './components/UnitView.js';
import { useSidebarLayout } from './layout.js';
import type { UnitActions } from './unit-context.js';

interface Selection {
  session: string | null;
  unit: string | null;
}

// Coalesces bursts of SSE events (streamed answers emit many) into one refetch.
const REFRESH_DELAY_MS = 150;

export function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [units, setUnits] = useState<Record<string, ReviewUnit[] | undefined>>({});
  const [activity, setActivity] = useState<SessionActivity[]>([]);
  const [sel, setSel] = useState<Selection>({ session: null, unit: null });
  const [error, setError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const layout = useSidebarLayout();
  const switcher = useHoldSwitcher();
  // Request counters so a slow, older response never overwrites a newer one.
  const seq = useRef(new Map<string, number>());

  const reportError = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 401) setUnauthorized(true);
    else setError(e instanceof Error ? e.message : String(e));
  }, []);

  const latest = useCallback(<T,>(key: string, load: () => Promise<T>, apply: (v: T) => void) => {
    const n = (seq.current.get(key) ?? 0) + 1;
    seq.current.set(key, n);
    return load().then((v) => {
      if (seq.current.get(key) === n) apply(v);
      return v;
    });
  }, []);

  const loadUnits = useCallback(
    (sessionId: string) =>
      latest(`units:${sessionId}`, () => api.units(sessionId), (list) => setUnits((prev) => ({ ...prev, [sessionId]: list }))),
    [latest],
  );

  const loadSessions = useCallback(() => latest('sessions', api.sessions, setSessions), [latest]);
  const loadActivity = useCallback(() => latest('activity', api.activity, setActivity), [latest]);

  const loadAll = useCallback(async () => {
    try {
      const [list] = await Promise.all([loadSessions(), loadActivity()]);
      await Promise.all(list.map((s) => loadUnits(s.sessionId)));
      setLoaded(true);
    } catch (e) {
      reportError(e);
    }
  }, [loadSessions, loadActivity, loadUnits, reportError]);

  useEffect(() => {
    void loadAll();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const schedule = (key: string, run: () => Promise<unknown>) => {
      if (timers.has(key)) return;
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          run().catch(reportError);
        }, REFRESH_DELAY_MS),
      );
    };
    let connectedBefore = false;
    const unsubscribe = subscribeEvents(
      (e) => {
        if (e.type === 'activity.updated') {
          schedule('activity', loadActivity);
          // Names and last-change times come with the session list.
          schedule('sessions', loadSessions);
          return;
        }
        schedule('sessions', loadSessions);
        schedule(`units:${e.sessionId}`, () => loadUnits(e.sessionId));
        // Follow a new reply in the session being viewed.
        if (e.type === 'unit.created') {
          setSel((cur) => (cur.session === null || cur.session === e.sessionId ? { session: e.sessionId, unit: e.unitId } : cur));
        }
      },
      () => {
        // Events may have been missed while disconnected: resync everything.
        if (connectedBefore) void loadAll();
        connectedBefore = true;
      },
    );
    return () => {
      unsubscribe();
      timers.forEach(clearTimeout);
    };
  }, [loadAll, loadSessions, loadActivity, loadUnits, reportError]);

  // Default to the most recent session and its latest unit.
  useEffect(() => {
    if (sel.session || sessions.length === 0) return;
    const first = sessions[0];
    const list = units[first.sessionId];
    if (list) setSel({ session: first.sessionId, unit: list[list.length - 1]?.id ?? null });
  }, [sessions, units, sel.session]);

  // A session that is responding before its first reply has no units yet: list it too, on top.
  const sidebarSessions = useMemo(() => {
    const known = new Set(sessions.map((s) => s.sessionId));
    const fresh: SessionSummary[] = activity
      .filter((a) => !known.has(a.sessionId))
      .map((a) => ({ sessionId: a.sessionId, agent: a.agent, cwd: a.cwd, lastActivity: a.since }));
    return fresh.length ? [...fresh, ...sessions] : sessions;
  }, [sessions, activity]);
  const selectSession = (session: string) => {
    const list = units[session];
    setSel({ session, unit: list?.[list.length - 1]?.id ?? null });
  };
  const respondingIds = useMemo(() => new Set(activity.map((a) => a.sessionId)), [activity]);
  const selectedActivity = sel.session ? activity.find((a) => a.sessionId === sel.session) : undefined;

  const shown = sel.session && sel.unit ? (units[sel.session]?.find((u) => u.id === sel.unit) ?? null) : null;
  const shownId = shown?.id;
  const shownSession = shown?.sessionId;

  const actions = useMemo<UnitActions | null>(() => {
    if (!shownId || !shownSession) return null;
    const run = async (call: () => Promise<unknown>) => {
      try {
        await call();
      } catch (e) {
        reportError(e);
        loadUnits(shownSession).catch(() => {});
        throw e;
      }
      await loadUnits(shownSession).catch(reportError);
    };
    return {
      addThread: (anchor, question, parentThreadId) => run(() => api.addThread(shownId, anchor, question, parentThreadId)),
      deleteThread: (id) => run(() => api.deleteThread(id)),
      sendDrafts: () => run(() => api.sendDrafts(shownId)),
      followUp: (id, text) => run(() => api.followUp(id, text)),
      retry: (id) => run(() => api.retry(id)),
      resolve: (id) => run(() => api.resolve(id)),
      setConclusion: (id, conclusion) => run(() => api.setConclusion(id, conclusion)),
      submit: () => run(() => api.submit(shownId)),
      addFile: (path) => run(() => api.addFile(shownId, path)),
    };
  }, [shownId, shownSession, loadUnits, reportError]);

  if (unauthorized) {
    return (
      <div className="gate">
        <h1>尚未授權</h1>
        <p>請使用啟動 Agent Console 時 terminal 顯示的網址（含 /auth?token=…）開啟面板。</p>
      </div>
    );
  }

  const navToggle = layout.open ? null : (
    <button type="button" className="btn ghost nav-toggle" aria-label="顯示側欄" title="顯示側欄" onClick={layout.show}>
      ☰
    </button>
  );

  return (
    <div className={`app ${layout.compact ? 'layout-compact' : 'layout-wide'}${layout.open ? ' sidebar-open' : ''}`}>
      {layout.open && (
        <Sidebar
          sessions={sidebarSessions}
          responding={respondingIds}
          unitsBySession={units}
          selectedSession={sel.session}
          drawer={layout.compact}
          onHide={layout.hide}
          onSelect={(session) => {
            selectSession(session);
            // In the drawer, picking a session returns the full screen to the content.
            if (layout.compact) layout.hide();
          }}
        />
      )}
      {layout.compact && layout.open && <div className="drawer-backdrop" aria-hidden="true" onClick={layout.hide} />}
      {switcher.open && (
        <SessionSwitcher
          sessions={sidebarSessions}
          unitsBySession={units}
          activity={activity}
          selectedSession={sel.session}
          onSelect={(session) => {
            selectSession(session);
            switcher.close();
            if (layout.compact) layout.hide();
          }}
        />
      )}
      <div className="main">
        {error && (
          <div className="toast" role="alert">
            <span>操作失敗：{error}</span>
            <button type="button" className="btn ghost small" onClick={() => setError(null)}>
              關閉
            </button>
          </div>
        )}
        {shown && actions ? (
          <UnitView key={shown.id} unit={shown} actions={actions} navToggle={navToggle} responding={selectedActivity} />
        ) : (
          <>
            {navToggle && <div className="tabs">{navToggle}</div>}
            {selectedActivity && <RespondingBanner activity={selectedActivity} />}
            <div className="placeholder">
              {!loaded ? '載入中…' : selectedActivity ? '這個對話還沒有回覆。' : '選擇側欄中的一則回覆開始審查。'}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
