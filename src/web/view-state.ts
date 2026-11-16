import type { StreamAnchor } from './scroll.js';

/**
 * Storage key for the session on screen and the reading position in it, restored after a reload. Each
 * tab keeps its own copy in sessionStorage (so tabs do not overwrite each other's place); the copy in
 * localStorage is the place any tab saved last, where a new tab starts.
 */
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

function parse(text: string | null): ViewState | null {
  try {
    const raw = JSON.parse(text ?? 'null') as { session?: unknown; anchor?: unknown } | null;
    if (!raw || typeof raw !== 'object' || typeof raw.session !== 'string') return null;
    return { session: raw.session, anchor: isAnchor(raw.anchor) ? raw.anchor : null };
  } catch {
    return null;
  }
}

function read(storage: () => Storage): string | null {
  try {
    return storage().getItem(VIEW_STATE_KEY);
  } catch {
    return null;
  }
}

export function loadViewState(): ViewState {
  return parse(read(() => sessionStorage)) ?? parse(read(() => localStorage)) ?? EMPTY;
}

export function saveViewState(state: ViewState): void {
  const text = JSON.stringify(state);
  for (const storage of [() => sessionStorage, () => localStorage]) {
    try {
      storage().setItem(VIEW_STATE_KEY, text);
    } catch {
      // Not remembered (storage full or blocked); harmless.
    }
  }
}
