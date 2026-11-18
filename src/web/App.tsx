import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReviewUnit } from '../shared/types.js';
import { ApiError, api, subscribeEvents, type AuthMode, type SessionActivity, type SessionSummary } from './api.js';
import { ConversationView } from './components/ConversationView.js';
import { Login } from './components/Login.js';
import { RespondingBanner } from './components/Responding.js';
import { SessionSwitcher, useHoldSwitcher } from './components/SessionSwitcher.js';
import { Sidebar } from './components/Sidebar.js';
import { useSidebarLayout } from './layout.js';
import type { UnitActions } from './unit-context.js';
import { loadViewState, saveViewState } from './view-state.js';

// Coalesces bursts of SSE events (streamed answers emit many) into one refetch.
const REFRESH_DELAY_MS = 150;

/** The new list, reusing the previous object for every unit that did not change (so its turn is not re-rendered). */
function keepUnchanged(prev: ReviewUnit[] | undefined, next: ReviewUnit[]): ReviewUnit[] {
  if (!prev) return next;
  const old = new Map(prev.map((u) => [u.id, u]));
  return next.map((u) => {
    const p = old.get(u.id);
    return p && JSON.stringify(p) === JSON.stringify(u) ? p : u;
  });
}

export function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [units, setUnits] = useState<Record<string, ReviewUnit[] | undefined>>({});
  const [activity, setActivity] = useState<SessionActivity[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  // How this entry authenticates; null until known (or when the server does not say).
  const [authMode, setAuthMode] = useState<AuthMode | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Where the page was before a reload; the anchor is used once, for that session's first showing.
  const [restored] = useState(loadViewState);
  const [initialAnchor, setInitialAnchor] = useState(restored.anchor);
  const layout = useSidebarLayout();
  const switcher = useHoldSwitcher();
  // Request counters so a slow, older response never overwrites a newer one.
  const seq = useRef(new Map<string, number>());

  // The entry's mode is learned once and kept: a failed lookup must not forget a known mode.
  const modeRef = useRef<AuthMode | null>(null);
  const fetchMode = useCallback(async () => {
    try {
      const m = await api.authMode();
      modeRef.current = m;
      setAuthMode(m);
    } catch {
      /* keep what we knew (possibly nothing) */
    }
  }, []);

  // Not signed in (401, sign-out, or the server revoked the session): drop everything that was loaded and show
  // the sign-in form (password entry), the "open the printed URL" message (token entry), or, when the mode
  // is not known, a retry prompt.
  const markUnauthorized = useCallback(async () => {
    setSessions([]);
    setUnits({});
    setActivity([]);
    setSelected(null);
    setLoaded(false);
    setError(null);
    setUnauthorized(true);
    if (!modeRef.current) await fetchMode();
  }, [fetchMode]);

  const reportError = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) void markUnauthorized();
      else setError(e instanceof Error ? e.message : String(e));
    },
    [markUnauthorized],
  );

  // Learn the entry's mode up front: the Sign out button exists only on the password entry.
  useEffect(() => {
    void fetchMode();
  }, [fetchMode]);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    await markUnauthorized();
  }, [markUnauthorized]);

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
      latest(`units:${sessionId}`, () => api.units(sessionId), (list) =>
        setUnits((prev) => ({ ...prev, [sessionId]: keepUnchanged(prev[sessionId], list) })),
      ),
    [latest],
  );

  const loadSessions = useCallback(() => latest('sessions', api.sessions, setSessions), [latest]);
  const loadActivity = useCallback(() => latest('activity', api.activity, setActivity), [latest]);

  const loadAll = useCallback(async () => {
    try {
      const [list] = await Promise.all([loadSessions(), loadActivity()]);
      await Promise.all(list.map((s) => loadUnits(s.sessionId)));
      setLoaded(true);
      // The mode lookup at startup may have failed; the API answering is a good moment to try again.
      if (!modeRef.current) void fetchMode();
    } catch (e) {
      reportError(e);
    }
  }, [loadSessions, loadActivity, loadUnits, reportError, fetchMode]);

  // While signed out nothing is loaded and no event stream is held (its lock passes to a tab that is signed in);
  // signing in flips `unauthorized` back and this effect loads the panel and subscribes afresh.
  useEffect(() => {
    if (unauthorized) return;
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
        if (e.type === 'auth.revoked') {
          void markUnauthorized();
          return;
        }
        if (e.type === 'activity.updated') {
          schedule('activity', loadActivity);
          // Names and last-change times come with the session list.
          schedule('sessions', loadSessions);
          return;
        }
        schedule('sessions', loadSessions);
        schedule(`units:${e.sessionId}`, () => loadUnits(e.sessionId));
        // Nothing open yet: show the session that just replied.
        if (e.type === 'unit.created') setSelected((cur) => cur ?? e.sessionId);
      },
      () => {
        // Events may have been missed while disconnected: resync everything.
        if (connectedBefore) void loadAll();
        connectedBefore = true;
      },
      // The server refused the stream for good (session gone without an auth.revoked event).
      () => void markUnauthorized(),
    );
    return () => {
      unsubscribe();
      timers.forEach(clearTimeout);
    };
  }, [unauthorized, loadAll, loadSessions, loadActivity, loadUnits, reportError, markUnauthorized]);

  // A session that is responding before its first reply has no units yet: list it too, on top.
  const sidebarSessions = useMemo(() => {
    const known = new Set(sessions.map((s) => s.sessionId));
    const fresh: SessionSummary[] = activity
      .filter((a) => !known.has(a.sessionId))
      .map((a) => ({ sessionId: a.sessionId, agent: a.agent, cwd: a.cwd, lastActivity: a.since }));
    return fresh.length ? [...fresh, ...sessions] : sessions;
  }, [sessions, activity]);

  // Reopen the session from before the reload; otherwise (once everything is loaded) the most recent one.
  useEffect(() => {
    if (selected) return;
    if (restored.session && sidebarSessions.some((s) => s.sessionId === restored.session)) {
      setSelected(restored.session);
      return;
    }
    if ((loaded || !restored.session) && sessions.length > 0) setSelected(sessions[0].sessionId);
  }, [sessions, sidebarSessions, selected, loaded, restored.session]);

  const respondingIds = useMemo(() => new Set(activity.map((a) => a.sessionId)), [activity]);
  const selectedActivity = selected ? activity.find((a) => a.sessionId === selected) : undefined;
  const selectedUnits = selected ? units[selected] : undefined;
  const selectedSummary = selected ? sidebarSessions.find((s) => s.sessionId === selected) : undefined;

  // One actions object per unit for the page's lifetime, so unchanged turns are not re-rendered.
  const actionsCache = useRef(new Map<string, UnitActions>());
  const actionsFor = useCallback(
    (unit: ReviewUnit): UnitActions => {
      const cached = actionsCache.current.get(unit.id);
      if (cached) return cached;
      const unitId = unit.id;
      const sessionId = unit.sessionId;
      const run = async (call: () => Promise<unknown>) => {
        try {
          await call();
        } catch (e) {
          reportError(e);
          loadUnits(sessionId).catch(() => {});
          throw e;
        }
        await loadUnits(sessionId).catch(reportError);
      };
      const actions: UnitActions = {
        addThread: (anchor, question, parentThreadId) => run(() => api.addThread(unitId, anchor, question, parentThreadId)),
        deleteThread: (id) => run(() => api.deleteThread(id)),
        sendThread: (id) => run(() => api.sendThread(id)),
        followUp: (id, text) => run(() => api.followUp(id, text)),
        retry: (id) => run(() => api.retry(id)),
        integrate: () => run(() => api.integrate(unitId)),
        addFile: (path) => run(() => api.addFile(unitId, path)),
      };
      actionsCache.current.set(unitId, actions);
      return actions;
    },
    [loadUnits, reportError],
  );

  const markSignedIn = async () => {
    await fetchMode();
    setUnauthorized(false);
  };

  const selectSession = (session: string) => {
    setSelected(session);
    setInitialAnchor(null);
    saveViewState({ session, anchor: null });
  };

  if (unauthorized) {
    if (authMode?.mode === 'password') return <Login onSignedIn={() => void markSignedIn()} />;
    if (authMode === null) {
      return (
        <div className="gate">
          <h1>Can't reach Agent Console.</h1>
          <p>The server did not answer.</p>
          <button type="button" className="btn" onClick={() => void fetchMode()}>
            Retry
          </button>
        </div>
      );
    }
    return (
      <div className="gate">
        <h1>Not signed in</h1>
        <p>Open the panel with the URL Agent Console printed in the terminal when it started (the one with /auth?token=…).</p>
      </div>
    );
  }

  const navToggle = layout.open ? null : (
    <button type="button" className="btn ghost nav-toggle" aria-label="Show sidebar" title="Show sidebar" onClick={layout.show}>
      ☰
    </button>
  );

  // A session is shown once its replies are loaded, or right away when it is responding before its first one.
  const respondingOnly = selectedActivity !== undefined && !sessions.some((s) => s.sessionId === selected);
  const showConversation = selected !== null && (selectedUnits !== undefined || respondingOnly);

  return (
    <div className={`app ${layout.compact ? 'layout-compact' : 'layout-wide'}${layout.open ? ' sidebar-open' : ''}`}>
      {layout.open && (
        <Sidebar
          sessions={sidebarSessions}
          responding={respondingIds}
          unitsBySession={units}
          selectedSession={selected}
          drawer={layout.compact}
          onHide={layout.hide}
          onSignOut={authMode?.mode === 'password' ? () => void signOut() : undefined}
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
          selectedSession={selected}
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
            <span>Action failed: {error}</span>
            <button type="button" className="btn ghost small" onClick={() => setError(null)}>
              Close
            </button>
          </div>
        )}
        {showConversation ? (
          <ConversationView
            key={selected}
            session={selectedSummary}
            units={selectedUnits ?? []}
            actionsFor={actionsFor}
            navToggle={navToggle}
            responding={selectedActivity}
            initialAnchor={selected === restored.session ? initialAnchor : null}
            onAnchorChange={(anchor) => saveViewState({ session: selected, anchor })}
          />
        ) : (
          <>
            {navToggle && <div className="tabs">{navToggle}</div>}
            {selectedActivity && <RespondingBanner activity={selectedActivity} />}
            <div className="placeholder">{!loaded || selected ? 'Loading…' : 'Select a conversation in the sidebar to start reviewing.'}</div>
          </>
        )}
      </div>
    </div>
  );
}
