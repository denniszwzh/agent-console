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
       
        onSelect={() => {}}
        onHide={() => {
          hidden = true;
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }));
    expect(hidden).toBe(true);
  });

  it('shows the session title with the folder below', () => {
    const base = { sessionId: 's1', agent: 'claude' as const, cwd: 'C:\\p\\stock', lastActivity: '2026-11-16T10:00:00.000Z' };
    const { container, rerender } = render(
      <Sidebar sessions={[{ ...base, title: 'K棒反向交易功能', titleSource: 'agent' }]} unitsBySession={{}} selectedSession={null} onSelect={() => {}} />,
    );
    const title = container.querySelector('.session-project')!;
    expect(title.textContent).toBe('K棒反向交易功能');
    expect(title.classList.contains('untitled')).toBe(false);
    expect(container.querySelector('.project-head')!.textContent).toContain('stock');
    rerender(
      <Sidebar sessions={[{ ...base, title: '幫我看 README', titleSource: 'prompt' }]} unitsBySession={{}} selectedSession={null} onSelect={() => {}} />,
    );
    expect(container.querySelector('.session-project')!.classList.contains('untitled')).toBe(true);
  });
});

describe('Sidebar groups', () => {
  const repo = { key: 'c:/p/repo', root: 'C:/p/repo' };
  const sessions = [
    { sessionId: 'a', agent: 'claude' as const, cwd: 'C:/p/repo/.claude/worktrees/feat-x', lastActivity: '2026-11-16T10:00:00.000Z', title: '甲', project: { ...repo, worktree: 'feat-x' } },
    { sessionId: 'b', agent: 'codex' as const, cwd: 'C:/p/other', lastActivity: '2026-11-16T09:00:00.000Z', title: '乙', project: { key: 'c:/p/other', root: 'C:/p/other' } },
    { sessionId: 'c', agent: 'claude' as const, cwd: 'C:/p/repo', lastActivity: '2026-11-16T08:00:00.000Z', title: '丙', project: repo },
  ];
  const titles = (c: HTMLElement) => [...c.querySelectorAll('.session-project')].map((e) => e.textContent);

  it('groups sessions by project and collapses a group', () => {
    const view = render(<Sidebar sessions={sessions} unitsBySession={{}} selectedSession={null} onSelect={() => {}} />);
    const heads = [...view.container.querySelectorAll('.project-head')];
    expect(heads.map((h) => h.textContent)).toEqual([expect.stringContaining('repo'), expect.stringContaining('other')]);
    expect(titles(view.container)).toEqual(['甲', '丙', '乙']);
    fireEvent.click(heads[0]);
    expect(heads[0].getAttribute('aria-expanded')).toBe('false');
    expect(titles(view.container)).toEqual(['乙']);
    view.unmount();
    const again = render(<Sidebar sessions={sessions} unitsBySession={{}} selectedSession={null} onSelect={() => {}} />);
    expect(titles(again.container)).toEqual(['乙']);
  });

  it('selects a session by id', () => {
    const picked: string[] = [];
    render(<Sidebar sessions={sessions} unitsBySession={{}} selectedSession={null} onSelect={(id) => picked.push(id)} />);
    fireEvent.click(screen.getByText('乙'));
    expect(picked).toEqual(['b']);
  });

  it('no longer lists earlier replies', () => {
    const u = { id: 'u1', sessionId: 'a', createdAt: '2026-11-16T10:00:00.000Z', status: 'open', reply: { content: 'x' }, threads: [] };
    const { container } = render(
      <Sidebar sessions={sessions} unitsBySession={{ a: [u as never] }} selectedSession="a" onSelect={() => {}} />,
    );
    expect(container.querySelector('.unit-history')).toBeNull();
  });

  it('shows the worktree name', () => {
    const { container } = render(<Sidebar sessions={sessions} unitsBySession={{}} selectedSession={null} onSelect={() => {}} />);
    expect(container.querySelector('.session-meta')!.textContent).toContain('worktree: feat-x');
  });
});
