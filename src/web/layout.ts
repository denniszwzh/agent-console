import { useCallback, useEffect, useState } from 'react';

/**
 * Portrait screens (a monitor rotated 90 degrees) and narrow windows use the compact layout:
 * the sidebar becomes an overlay drawer so the content gets the full width.
 */
export const COMPACT_QUERY = '(orientation: portrait), (max-width: 900px)';

/** localStorage key remembering that the docked (wide-layout) sidebar was hidden. */
export const SIDEBAR_COLLAPSED_KEY = 'agent-console.sidebarCollapsed';

function matches(query: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
}

export function useMediaQuery(query: string): boolean {
  const [value, setValue] = useState(() => matches(query));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const onChange = (e: { matches: boolean }) => setValue(e.matches);
    setValue(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return value;
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Storage unavailable: the choice just is not remembered.
  }
}

export interface SidebarLayout {
  /** True in the portrait / narrow layout, where the sidebar is an overlay drawer. */
  compact: boolean;
  /** Whether the sidebar is visible (docked in the wide layout, drawer open in the compact one). */
  open: boolean;
  show(): void;
  hide(): void;
}

/**
 * Wide layout: the sidebar is docked and can be hidden; that choice persists.
 * Compact layout: the sidebar is a drawer, closed by default and on every switch into compact.
 */
export function useSidebarLayout(): SidebarLayout {
  const compact = useMediaQuery(COMPACT_QUERY);
  const [dockedOpen, setDockedOpen] = useState(() => !readCollapsed());
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    if (compact) setDrawerOpen(false);
  }, [compact]);

  useEffect(() => {
    if (!compact || !drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [compact, drawerOpen]);

  const show = useCallback(() => {
    if (compact) setDrawerOpen(true);
    else {
      setDockedOpen(true);
      writeCollapsed(false);
    }
  }, [compact]);

  const hide = useCallback(() => {
    if (compact) setDrawerOpen(false);
    else {
      setDockedOpen(false);
      writeCollapsed(true);
    }
  }, [compact]);

  return { compact, open: compact ? drawerOpen : dockedOpen, show, hide };
}
