// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { COMPACT_QUERY, SIDEBAR_COLLAPSED_KEY, useSidebarLayout } from '../../src/web/layout.js';
import { Sidebar } from '../../src/web/components/Sidebar.js';

type Listener = (e: { matches: boolean }) => void;

// Minimal controllable matchMedia: `compact` decides whether COMPACT_QUERY matches.
function installMatchMedia(compact: boolean) {
  const listeners = new Set<Listener>();
  let matches = compact;
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query === COMPACT_QUERY ? matches : false;
    },
    media: query,
    addEventListener: (_: string, l: Listener) => listeners.add(l),
    removeEventListener: (_: string, l: Listener) => listeners.delete(l),
  })) as unknown as typeof window.matchMedia;
  return {
    set(next: boolean) {
      matches = next;
      listeners.forEach((l) => l({ matches: next }));
    },
  };
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('useSidebarLayout', () => {
  it('wide screens dock the sidebar open by default', () => {
    installMatchMedia(false);
    const { result } = renderHook(() => useSidebarLayout());
    expect(result.current.compact).toBe(false);
    expect(result.current.open).toBe(true);
  });

  it('collapsing the docked sidebar is remembered across reloads', () => {
    installMatchMedia(false);
    const first = renderHook(() => useSidebarLayout());
    act(() => first.result.current.hide());
    expect(first.result.current.open).toBe(false);
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe('1');
    first.unmount();
    const second = renderHook(() => useSidebarLayout());
    expect(second.result.current.open).toBe(false);
    act(() => second.result.current.show());
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe('0');
  });

  it('portrait or narrow screens start with the drawer closed', () => {
    installMatchMedia(true);
    const { result } = renderHook(() => useSidebarLayout());
    expect(result.current.compact).toBe(true);
    expect(result.current.open).toBe(false);
    act(() => result.current.show());
    expect(result.current.open).toBe(true);
    // The drawer state is never persisted.
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBeNull();
  });

  it('rotating to portrait closes the drawer; rotating back restores the docked state', () => {
    const mm = installMatchMedia(false);
    const { result } = renderHook(() => useSidebarLayout());
    expect(result.current.open).toBe(true);
    act(() => mm.set(true));
    expect(result.current.compact).toBe(true);
    expect(result.current.open).toBe(false);
    act(() => mm.set(false));
    expect(result.current.compact).toBe(false);
    expect(result.current.open).toBe(true);
  });

  it('Escape closes the open drawer', () => {
    installMatchMedia(true);
    const { result } = renderHook(() => useSidebarLayout());
    act(() => result.current.show());
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(result.current.open).toBe(false);
  });
});

describe('Sidebar', () => {
  it('offers a hide button when onHide is given', () => {
    let hidden = false;
    render(
      <Sidebar
        sessions={[]}
        unitsBySession={{}}
        selectedSession={null}
        selectedUnit={null}
        onSelect={() => {}}
        onHide={() => {
          hidden = true;
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '隱藏側欄' }));
    expect(hidden).toBe(true);
  });
});
