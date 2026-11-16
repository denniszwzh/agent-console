import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { Anchor, ReviewUnit, Thread } from '../shared/types.js';
import { imageUrl } from './api.js';

/**
 * Mutations the review UI can perform on the shown unit. Each one reports its
 * own failure to the user and then rejects, so callers can keep their input.
 */
export interface UnitActions {
  /** Creates a thread and sends it at once. */
  addThread(anchor: Anchor, question: string, parentThreadId?: string): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  /** Sends a leftover unsent thread. */
  sendThread(threadId: string): Promise<void>;
  followUp(threadId: string, text: string): Promise<void>;
  retry(threadId: string): Promise<void>;
  /** Concludes every answered thread and hands the conclusions to the main session. */
  integrate(): Promise<void>;
  addFile(path: string): Promise<void>;
}

export interface UnitContextValue {
  unit: ReviewUnit;
  /** Anything but an open unit is browse-only history; so is a unit whose conclusions are being integrated. */
  readOnly: boolean;
  actions: UnitActions;
  /** Threads anchored on one block of one source (a reply, a file, or 'msg:<id>'). */
  threadsAt(sourceId: string, blockId: string): Thread[];
  /** URL for a local image path as referenced by the given source. */
  imageUrl(sourceId: string, path: string): string;
}

const UnitContext = createContext<UnitContextValue | null>(null);

export function UnitProvider({ unit, actions, children }: { unit: ReviewUnit; actions: UnitActions; children: ReactNode }) {
  const value = useMemo<UnitContextValue>(() => {
    const byAnchor = new Map<string, Thread[]>();
    for (const t of unit.threads) {
      const key = `${t.anchor.sourceId}\n${t.anchor.blockId}`;
      const list = byAnchor.get(key);
      if (list) list.push(t);
      else byAnchor.set(key, [t]);
    }
    return {
      unit,
      readOnly: unit.status !== 'open' || unit.integrating === true,
      actions,
      threadsAt: (sourceId, blockId) => byAnchor.get(`${sourceId}\n${blockId}`) ?? [],
      imageUrl: (sourceId, p) => imageUrl(unit.id, sourceId, p),
    };
  }, [unit, actions]);
  return <UnitContext.Provider value={value}>{children}</UnitContext.Provider>;
}

export function useUnit(): UnitContextValue {
  const ctx = useContext(UnitContext);
  if (!ctx) throw new Error('useUnit must be used inside <UnitProvider>');
  return ctx;
}

/** The top-level source (reply or file id) a thread ultimately hangs from. */
export function rootSourceId(unit: ReviewUnit, thread: Thread): string {
  const byId = new Map(unit.threads.map((t) => [t.id, t]));
  let cur = thread;
  const seen = new Set<string>();
  while (cur.parentThreadId && !seen.has(cur.id)) {
    seen.add(cur.id);
    const parent = byId.get(cur.parentThreadId);
    if (!parent) break;
    cur = parent;
  }
  return cur.anchor.sourceId;
}

/** Threads across a session's units whose fork is answering right now. */
export function answeringThreadCount(units: ReviewUnit[] | undefined): number {
  if (!units) return 0;
  return units.reduce((n, u) => n + u.threads.filter((t) => t.status === 'answering').length, 0);
}

/** Run an action from an event handler; its failure has already been reported. */
export function fire(p: Promise<unknown>): void {
  p.catch(() => {});
}
