import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { Anchor, ReviewUnit, Thread } from '../shared/types.js';
import { imageUrl } from './api.js';

/**
 * Mutations the review UI can perform on the shown unit. Each one reports its
 * own failure to the user and then rejects, so callers can keep their input.
 */
export interface UnitActions {
  addThread(anchor: Anchor, question: string, parentThreadId?: string): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  sendDrafts(): Promise<void>;
  followUp(threadId: string, text: string): Promise<void>;
  retry(threadId: string): Promise<void>;
  resolve(threadId: string): Promise<void>;
  setConclusion(threadId: string, conclusion: string | null): Promise<void>;
  submit(): Promise<void>;
  addFile(path: string): Promise<void>;
}

export interface UnitContextValue {
  unit: ReviewUnit;
  /** Anything but an open unit is browse-only history. */
  readOnly: boolean;
  actions: UnitActions;
  /** Threads anchored on one block of one source (a reply, a file, or 'msg:<id>'). */
  threadsAt(sourceId: string, blockId: string): Thread[];
  imageUrl(path: string): string;
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
      readOnly: unit.status !== 'open',
      actions,
      threadsAt: (sourceId, blockId) => byAnchor.get(`${sourceId}\n${blockId}`) ?? [],
      imageUrl: (p) => imageUrl(unit.id, p),
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

export function isOpenThread(t: Thread): boolean {
  return t.status !== 'resolved' && t.status !== 'expired';
}

/** Run an action from an event handler; its failure has already been reported. */
export function fire(p: Promise<unknown>): void {
  p.catch(() => {});
}
