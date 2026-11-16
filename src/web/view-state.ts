import type { StreamAnchor } from './scroll.js';

/** localStorage key: the session on screen and the reading position in it, restored after a reload. */
export const VIEW_STATE_KEY = 'agent-console.view';

export interface ViewState {
  session: string | null;
  anchor: StreamAnchor | null;
}

const EMPTY: ViewState = { session: null, anchor: null };

function isAnchor(v: unknown): v is StreamAnchor {
  const a = v as StreamAnchor | null;
  return !!a && typeof a === 'object' && typeof a.unitId === 'string' && typeof a.offset === 'number' && Number.isFinite(a.offset);
}

export function loadViewState(): ViewState {
  try {
    const raw = JSON.parse(localStorage.getItem(VIEW_STATE_KEY) ?? 'null') as { session?: unknown; anchor?: unknown } | null;
    if (!raw || typeof raw !== 'object' || typeof raw.session !== 'string') return EMPTY;
    return { session: raw.session, anchor: isAnchor(raw.anchor) ? raw.anchor : null };
  } catch {
    return EMPTY;
  }
}

export function saveViewState(state: ViewState): void {
  try {
    localStorage.setItem(VIEW_STATE_KEY, JSON.stringify(state));
  } catch {
    // Not remembered (storage full or blocked); harmless.
  }
}
