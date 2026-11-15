import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReviewUnit } from '../shared/types.js';
import { ApiError, api, subscribeEvents, type SessionSummary } from './api.js';
import { Sidebar } from './components/Sidebar.js';
import { UnitView } from './components/UnitView.js';
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
  const [sel, setSel] = useState<Selection>({ session: null, unit: null });
  const [error, setError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [loaded, setLoaded] = useState(false);
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

  const loadAll = useCallback(async () => {
    try {
      const list = await loadSessions();
      await Promise.all(list.map((s) => loadUnits(s.sessionId)));
      setLoaded(true);
    } catch (e) {
      reportError(e);
    }
  }, [loadSessions, loadUnits, reportError]);

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
  }, [loadAll, loadSessions, loadUnits, reportError]);

  // Default to the most recent session and its latest unit.
  useEffect(() => {
    if (sel.session || sessions.length === 0) return;
    const first = sessions[0];
    const list = units[first.sessionId];
    if (list) setSel({ session: first.sessionId, unit: list[list.length - 1]?.id ?? null });
  }, [sessions, units, sel.session]);

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

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        unitsBySession={units}
        selectedSession={sel.session}
        selectedUnit={sel.unit}
        onSelect={(session, unit) => setSel({ session, unit })}
      />
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
          <UnitView key={shown.id} unit={shown} actions={actions} />
        ) : (
          <div className="placeholder">{loaded ? '選擇左側的一則回覆開始審查。' : '載入中…'}</div>
        )}
      </div>
    </div>
  );
}
