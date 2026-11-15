import type { ReviewUnit } from './types.js';

/**
 * Submission gate shared by the server and the web UI: the unit must be open,
 * have at least one thread, and every thread (nested ones included) must be resolved.
 */
export function canSubmit(unit: ReviewUnit): boolean {
  return unit.status === 'open' && unit.threads.length > 0 && unit.threads.every((t) => t.status === 'resolved');
}
