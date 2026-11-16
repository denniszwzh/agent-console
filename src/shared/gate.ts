import type { ReviewUnit, Thread } from './types.js';

/**
 * Submission gate shared by the server and the web UI: the unit must be open,
 * have at least one thread, and every thread (nested ones included) must be resolved.
 */
export function canSubmit(unit: ReviewUnit): boolean {
  return unit.status === 'open' && unit.threads.length > 0 && unit.threads.every((t) => t.status === 'resolved');
}

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
