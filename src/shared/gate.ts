import type { ReviewUnit, Thread } from './types.js';

/** Threads that never enter the conclusions: unsent drafts, failed runs and expired threads. */
export function isExcluded(t: Thread): boolean {
  return t.status === 'draft' || t.status === 'error' || t.status === 'expired';
}

export interface IntegrationState {
  /** Threads whose fork is answering (or concluding) right now. */
  answering: number;
  /** Threads with an answer: awaiting a conclusion or already concluded. */
  answered: number;
  /** Threads that have their conclusion. */
  concluded: number;
  /** Threads that take part in the conclusions (not excluded). */
  total: number;
  /** Whether "integrate conclusions" can start now. */
  canIntegrate: boolean;
}

/**
 * Integration gate shared by the server and the web UI: the unit must be open and not already
 * integrating, no thread may still be answering, and at least one thread must have an answer.
 */
export function integrationState(unit: ReviewUnit): IntegrationState {
  const taking = unit.threads.filter((t) => !isExcluded(t));
  const answering = taking.filter((t) => t.status === 'answering').length;
  const concluded = taking.filter((t) => t.status === 'resolved').length;
  const answered = taking.filter((t) => t.status === 'awaiting').length + concluded;
  const canIntegrate = unit.status === 'open' && unit.integrating !== true && answering === 0 && answered > 0;
  return { answering, answered, concluded, total: taking.length, canIntegrate };
}

/**
 * The nearest descendants of a thread that take part in the conclusions: an excluded child is looked
 * through to its own children, so a thread under a failed one still reaches its concluded ancestor.
 */
export function concludableChildren(threads: Thread[], id: string): Thread[] {
  const out: Thread[] = [];
  const seen = new Set<string>([id]);
  const walk = (parent: string) => {
    for (const t of threads) {
      if (t.parentThreadId !== parent || seen.has(t.id)) continue;
      seen.add(t.id);
      if (isExcluded(t)) walk(t.id);
      else out.push(t);
    }
  };
  walk(id);
  return out;
}

/** Whether an ancestor taking part in the conclusions carries this thread's conclusion. */
export function carriedByAncestor(threads: Thread[], thread: Thread): boolean {
  const byId = new Map(threads.map((t) => [t.id, t]));
  const seen = new Set<string>([thread.id]);
  for (let p = thread.parentThreadId ? byId.get(thread.parentThreadId) : undefined; p && !seen.has(p.id); p = p.parentThreadId ? byId.get(p.parentThreadId) : undefined) {
    seen.add(p.id);
    if (!isExcluded(p)) return true;
  }
  return false;
}
