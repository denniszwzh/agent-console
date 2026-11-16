import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ReviewUnit, SessionActivity, SessionSummary } from '../../shared/types.js';
import { basename } from '../labels.js';
import { anchorTop, nearBottom, topAnchor, type StreamAnchor } from '../scroll.js';
import { UnitProvider, rootSourceId, type UnitActions } from '../unit-context.js';
import { ConclusionBar } from './ConclusionBar.js';
import { RespondingBanner } from './Responding.js';
import { AddFileButton, SourceTabs, type TabSpec } from './SourceTabs.js';
import { SourceView } from './SourceView.js';
import { TurnView } from './TurnView.js';

/** Turns rendered at first, and added each time the reader nears the top. */
const PAGE = 30;
/** Earlier turns are loaded once the view is this close to the top. */
const LOAD_MORE_PX = 200;
/** The reading position is reported at most this often. */
const ANCHOR_THROTTLE_MS = 300;
const STREAM = 'stream';

interface TempTab {
  id: string;
  unitId: string;
  sourceId: string;
  turnNumber: number;
}

interface Props {
  session: SessionSummary | undefined;
  /** The session's replies, oldest first. */
  units: ReviewUnit[];
  actionsFor(unit: ReviewUnit): UnitActions;
  navToggle?: ReactNode;
  /** Set while the main session is working on a new turn. */
  responding?: SessionActivity;
  /** Where to open the conversation (after a reload); the bottom when absent or gone. */
  initialAnchor?: StreamAnchor | null;
  /** The reading position (null at the bottom), reported while the conversation tab is shown. */
  onAnchorChange?(anchor: StreamAnchor | null): void;
}

const tabId = (unitId: string, sourceId: string) => `${unitId}:${sourceId}`;

/** Threads under one tab whose fork is answering right now. */
function openCount(unit: ReviewUnit, sourceId: string): number {
  return unit.threads.filter((t) => t.status === 'answering' && rootSourceId(unit, t) === sourceId).length;
}

/**
 * A whole session as one conversation, like the terminal: every turn's prompts and reply, oldest
 * first, opened at the bottom. Only the newest turn can be reviewed while it is open; its files are
 * tabs, and files of earlier turns open as temporary tabs.
 */
export function ConversationView({ session, units, actionsFor, navToggle, responding, initialAnchor, onAnchorChange }: Props) {
  const latest = units[units.length - 1] as ReviewUnit | undefined;
  const [active, setActive] = useState(STREAM);
  const [temps, setTemps] = useState<TempTab[]>([]);
  const [firstIndex, setFirstIndex] = useState(() => {
    const base = Math.max(0, units.length - PAGE);
    const at = initialAnchor ? units.findIndex((u) => u.id === initialAnchor.unitId) : -1;
    return at >= 0 ? Math.min(base, at) : base;
  });
  const [newTurn, setNewTurn] = useState(false);

  const streamRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  /** Kept in place while content grows (images, diagrams), until the reader scrolls. */
  const pinned = useRef<'bottom' | StreamAnchor | null>(null);
  /** Whether the view was at the bottom before the latest change; decides whether a new turn is followed. */
  const atBottom = useRef(true);
  /** scrollTop we set ourselves, so its scroll event is not taken as the reader's. */
  const expectedTop = useRef<number | null>(null);
  const loading = useRef<{ height: number; top: number } | null>(null);
  /** The conversation's position while a file tab is shown. */
  const savedTop = useRef(0);
  const lastId = useRef(latest?.id);
  const awaitingFile = useRef<number | null>(null);
  const anchorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const firstRef = useRef(firstIndex);
  firstRef.current = firstIndex;
  const reportRef = useRef(onAnchorChange);
  reportRef.current = onAnchorChange;

  const setScroll = useCallback((top: number) => {
    const el = streamRef.current;
    if (!el) return;
    el.scrollTop = top;
    expectedTop.current = el.scrollTop;
    atBottom.current = nearBottom(el);
  }, []);

  const applyPin = useCallback(() => {
    const el = streamRef.current;
    const p = pinned.current;
    if (!el || !p) return;
    const top = p === 'bottom' ? null : anchorTop(el, p);
    if (top === null) pinned.current = 'bottom';
    setScroll(top ?? el.scrollHeight);
  }, [setScroll]);

  const report = useCallback(() => {
    anchorTimer.current = null;
    const el = streamRef.current;
    if (!el || activeRef.current !== STREAM) return;
    reportRef.current?.(nearBottom(el) ? null : topAnchor(el));
  }, []);

  const loadMore = useCallback(() => {
    const el = streamRef.current;
    if (!el || loading.current || firstRef.current === 0) return;
    loading.current = { height: el.scrollHeight, top: el.scrollTop };
    setFirstIndex((f) => Math.max(0, f - PAGE));
  }, []);

  // Open at the remembered place, else at the bottom.
  useLayoutEffect(() => {
    pinned.current = initialAnchor && units.some((u) => u.id === initialAnchor.unitId) ? initialAnchor : 'bottom';
    applyPin();
    // Mount only: later anchors are the reader's own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Earlier turns were added above: keep the reader's text where it was.
  useLayoutEffect(() => {
    const el = streamRef.current;
    const before = loading.current;
    if (!el || !before) return;
    loading.current = null;
    if (pinned.current) applyPin();
    else setScroll(before.top + (el.scrollHeight - before.height));
  }, [firstIndex, applyPin, setScroll]);

  // Too few turns to scroll: load earlier ones right away.
  useLayoutEffect(() => {
    const el = streamRef.current;
    if (el && active === STREAM && firstIndex > 0 && el.scrollHeight <= el.clientHeight) loadMore();
  });

  // A new turn arrived.
  useLayoutEffect(() => {
    const previous = lastId.current;
    if (latest?.id === previous) return;
    lastId.current = latest?.id;
    const cur = activeRef.current;
    if (cur !== STREAM && previous && cur.startsWith(`${previous}:`)) {
      // The file tab being read belonged to the previous turn: keep it open as that turn's tab.
      const sourceId = cur.slice(previous.length + 1);
      const turnNumber = units.findIndex((u) => u.id === previous) + 1;
      setTemps((t) => (t.some((x) => x.id === cur) ? t : [...t, { id: cur, unitId: previous, sourceId, turnNumber }]));
    }
    if (pinned.current === 'bottom' || atBottom.current) {
      pinned.current = 'bottom';
      if (cur === STREAM) applyPin();
    } else {
      setNewTurn(true);
    }
  }, [latest?.id, units, applyPin]);

  // Content grew (a diagram rendered, an image loaded): stay where the view was put.
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (activeRef.current !== STREAM) return;
      // Like a terminal: a reader sitting at the bottom keeps seeing what is added below.
      if (!pinned.current && atBottom.current) pinned.current = 'bottom';
      applyPin();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [applyPin]);

  // A reload must not lose the last moments of scrolling.
  useEffect(() => {
    const flush = () => {
      if (anchorTimer.current) {
        clearTimeout(anchorTimer.current);
        report();
      }
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      // Switching sessions: the next session's state is written by the selection itself.
      if (anchorTimer.current) clearTimeout(anchorTimer.current);
    };
  }, [report]);

  /** Switches tabs, remembering the conversation's position when leaving it. */
  const select = useCallback((id: string) => {
    const el = streamRef.current;
    if (activeRef.current === STREAM && id !== STREAM && el) savedTop.current = el.scrollTop;
    setActive(id);
  }, []);

  // After "add file", switch to the new tab once it arrives.
  const fileCount = latest?.files.length ?? 0;
  useEffect(() => {
    if (!latest || awaitingFile.current === null || fileCount <= awaitingFile.current) return;
    awaitingFile.current = null;
    select(tabId(latest.id, latest.files[fileCount - 1].id));
  }, [fileCount, latest, select]);

  const onScroll = () => {
    const el = streamRef.current;
    if (!el || activeRef.current !== STREAM) return;
    const ours = expectedTop.current !== null && el.scrollTop === expectedTop.current;
    expectedTop.current = null;
    atBottom.current = nearBottom(el);
    if (atBottom.current) setNewTurn(false);
    if (el.scrollTop < LOAD_MORE_PX && firstRef.current > 0) loadMore();
    if (!ours && !anchorTimer.current) anchorTimer.current = setTimeout(report, ANCHOR_THROTTLE_MS);
  };

  /** The reader took over (wheel, touch, keys, scrollbar): stop holding the view in place. */
  const release = () => {
    pinned.current = null;
  };

  const toBottom = () => {
    pinned.current = 'bottom';
    setNewTurn(false);
    applyPin();
  };

  // Back on the conversation tab: return to where it was.
  const prevActive = useRef(active);
  useLayoutEffect(() => {
    if (prevActive.current !== STREAM && active === STREAM) {
      if (pinned.current) applyPin();
      else setScroll(savedTop.current);
    }
    prevActive.current = active;
  }, [active, applyPin, setScroll]);

  // Read through a ref so onOpenFile stays the same function and unchanged turns skip re-rendering.
  const unitsRef = useRef(units);
  unitsRef.current = units;

  const onOpenFile = useCallback(
    (unitId: string, sourceId: string) => {
      const id = tabId(unitId, sourceId);
      if (unitId !== lastId.current) {
        const turnNumber = unitsRef.current.findIndex((u) => u.id === unitId) + 1;
        setTemps((t) => (t.some((x) => x.id === id) ? t : [...t, { id, unitId, sourceId, turnNumber }]));
      }
      select(id);
    },
    [select],
  );

  const close = (id: string) => {
    setTemps((t) => t.filter((x) => x.id !== id));
    if (active === id) setActive(STREAM);
  };

  const byId = useMemo(() => new Map(units.map((u) => [u.id, u])), [units]);
  const tabs: TabSpec[] = [{ id: STREAM, label: 'Conversation', count: latest ? openCount(latest, latest.reply.id) : 0 }];
  for (const f of latest?.files ?? []) {
    tabs.push({ id: tabId(latest!.id, f.id), label: basename(f.path ?? 'file'), title: f.path, count: openCount(latest!, f.id), guess: f.detectedBy === 'mtime' });
  }
  for (const t of temps) {
    if (t.unitId === latest?.id) continue;
    const f = byId.get(t.unitId)?.files.find((x) => x.id === t.sourceId);
    if (!f) continue;
    const name = basename(f.path ?? 'file');
    tabs.push({ id: t.id, label: `${name} (turn ${t.turnNumber})`, title: f.path, closable: true, closeLabel: `Close ${name}` });
  }

  // The file shown in the file pane, if a file tab is active.
  let file: { unit: ReviewUnit; sourceId: string } | null = null;
  if (active !== STREAM && tabs.some((t) => t.id === active)) {
    const sep = active.indexOf(':');
    const unit = byId.get(active.slice(0, sep));
    if (unit) file = { unit, sourceId: active.slice(sep + 1) };
  }
  const showingStream = file === null;
  const fileSource = file ? file.unit.files.find((f) => f.id === file!.sourceId) : undefined;

  const agent = session?.agent ?? latest?.agent ?? responding?.agent ?? 'claude';
  const cwd = session?.cwd ?? latest?.cwd ?? responding?.cwd ?? '';
  const worktree = session?.project?.worktree;
  const latestReviewable = latest && (latest.status === 'open' || latest.status === 'submitted');
  const shown = units.slice(firstIndex);

  return (
    <div className="conversation">
      <header className="conversation-head" title={cwd}>
        <span className={`agent-badge agent-${agent}`}>{agent}</span>
        <span className="conversation-project">{basename(session?.project?.root ?? cwd) || cwd}</span>
        {worktree && <span className="conversation-worktree">worktree: {worktree}</span>}
      </header>
      <SourceTabs
        tabs={tabs}
        activeId={showingStream ? STREAM : active}
        onSelect={select}
        onClose={close}
        leading={navToggle}
        trailing={
          latest?.status === 'open' ? (
            <UnitProvider unit={latest} actions={actionsFor(latest)}>
              <AddFileButton
                onAdding={() => {
                  awaitingFile.current = latest.files.length;
                }}
              />
            </UnitProvider>
          ) : null
        }
      />
      <div
        className="stream"
        ref={streamRef}
        hidden={!showingStream}
        onScroll={onScroll}
        onWheel={release}
        onTouchStart={release}
        onKeyDown={release}
        onMouseDown={release}
      >
        <div className="stream-content" ref={contentRef}>
          {firstIndex > 0 ? (
            <button type="button" className="btn ghost stream-start" onClick={loadMore}>
              Load earlier turns
            </button>
          ) : (
            units.length > 0 && <div className="stream-start">Conversation started {new Date(units[0].createdAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', hour12: false })}</div>
          )}
          {shown.map((u, i) => (
            <TurnView
              key={u.id}
              unit={u}
              actions={actionsFor(u)}
              latest={firstIndex + i === units.length - 1}
              turnNumber={firstIndex + i + 1}
              onOpenFile={onOpenFile}
            />
          ))}
          {units.length === 0 && responding?.prompt && (
            <div className="turn-prompts">
              <div className="turn-prompt">
                <span className="turn-prompt-who">You:</span>
                <div className="turn-prompt-text">{responding.prompt}</div>
              </div>
            </div>
          )}
          {responding && <RespondingBanner activity={responding} unitOpen={latest?.status === 'open'} />}
        </div>
        {newTurn && (
          <button type="button" className="btn primary new-turn" onClick={toBottom}>
            ↓ New reply
          </button>
        )}
      </div>
      {file && fileSource && (
        <div className="file-pane">
          <UnitProvider unit={file.unit} actions={actionsFor(file.unit)}>
            <SourceView key={fileSource.id} source={fileSource} />
          </UnitProvider>
        </div>
      )}
      {latest && latestReviewable && (
        <UnitProvider unit={latest} actions={actionsFor(latest)}>
          <ConclusionBar />
        </UnitProvider>
      )}
    </div>
  );
}
