// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ConversationView } from '../../src/web/components/ConversationView.js';
import type { ReviewUnit, SessionActivity, SessionSummary } from '../../src/shared/types.js';
import { anchorOn, fakeActions, makeThread, makeUnit } from './fixtures.js';

/*
 * jsdom has no layout. Every turn is 100px tall and starts at 50 + 100 * index (below the "start"
 * line); the stream shows 300px. `extra` grows the content without adding turns.
 */
let extra = 0;
const saved: [string, PropertyDescriptor | undefined][] = [];
function define(name: string, get: (this: HTMLElement) => number) {
  saved.push([name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)]);
  Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get });
}
beforeAll(() => {
  define('scrollHeight', function () {
    return this.querySelectorAll('section.turn').length * 100 + 50 + extra;
  });
  define('clientHeight', () => 300);
  define('offsetHeight', () => 100);
  define('offsetTop', function () {
    if (this.tagName !== 'SECTION') return 0;
    const all = [...(this.parentElement?.querySelectorAll(':scope > section.turn') ?? [])];
    return 50 + 100 * all.indexOf(this);
  });
});
afterAll(() => {
  for (const [name, d] of saved) {
    if (d) Object.defineProperty(HTMLElement.prototype, name, d);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
});
afterEach(() => {
  cleanup();
  extra = 0;
  vi.unstubAllGlobals();
});

const actions = fakeActions();
const actionsFor = () => actions;
const turn = (i: number, over: Partial<ReviewUnit> = {}) =>
  makeUnit({ id: `u${i}`, createdAt: new Date(Date.UTC(2026, 10, 16, 0, i)).toISOString(), status: 'stale', ...over });
const turns = (n: number, latestOpen = true) => Array.from({ length: n }, (_, i) => turn(i, i === n - 1 && latestOpen ? { status: 'open' } : {}));
const session: SessionSummary = { sessionId: 'sess-1', agent: 'claude', cwd: 'C:/work', lastActivity: '', project: { key: 'c:/work', root: 'C:/work' } };

function view(units: ReviewUnit[], over: Partial<Parameters<typeof ConversationView>[0]> = {}) {
  return render(<ConversationView session={session} units={units} actionsFor={actionsFor} {...over} />);
}
const stream = () => document.querySelector<HTMLElement>('.stream')!;
const sections = () => [...document.querySelectorAll<HTMLElement>('section.turn')];
const scrollTo = (top: number) => {
  stream().scrollTop = top;
  fireEvent.wheel(stream());
  fireEvent.scroll(stream());
};

describe('ConversationView', () => {
  it('renders turns oldest first with the stream tab selected', () => {
    view(turns(3));
    expect(sections().map((s) => s.dataset.unitId)).toEqual(['u0', 'u1', 'u2']);
    expect(screen.getByRole('tab', { name: /對話/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText(/對話開始於/)).toBeTruthy();
  });

  it('only the latest open turn offers actions', () => {
    const units = turns(2);
    view(units);
    expect(screen.getAllByRole('button', { name: '提問' })).toHaveLength(units[1].reply.blocks.length);
    expect(screen.getAllByRole('button', { name: /送出結論/ })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /加入檔案/ })).toHaveLength(1);
  });

  it('no conclusion bar when the latest turn is stale', () => {
    view(turns(2, false));
    expect(screen.queryByRole('button', { name: /送出結論/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /加入檔案/ })).toBeNull();
  });

  it("tabs list the latest turn's files with open thread counts", () => {
    const unit = turn(0, { status: 'open' });
    unit.files = [{ id: 'f1', kind: 'file', path: 'src/x.ts', content: 'line one', blocks: [], language: 'ts' }];
    unit.threads = [
      makeThread('t1', anchorOn(unit)),
      makeThread('t2', anchorOn(unit), { status: 'resolved', conclusion: 'ok' }),
      makeThread('t3', { ...anchorOn(unit), sourceId: 'f1' }),
      makeThread('t4', { ...anchorOn(unit), sourceId: 'f1' }),
    ];
    view([unit]);
    expect(screen.getByRole('tab', { name: /對話\s*1/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /x\.ts\s*2/ })).toBeTruthy();
  });

  it('marks guessed files on their tab and explains how they were found', () => {
    const unit = turn(0, { status: 'open' });
    unit.files = [
      { id: 'f2', kind: 'file', path: 'shell.ts', content: 'b', blocks: [], detectedBy: 'git' },
      { id: 'f3', kind: 'file', path: 'guess.ts', content: 'c', blocks: [], detectedBy: 'mtime' },
    ];
    view([unit]);
    fireEvent.click(screen.getByRole('tab', { name: 'shell.ts' }));
    expect(screen.getByText(/比對這一輪的 git 狀態找到的/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /^guess\.ts\s*可能$/ }));
    expect(screen.getByText(/可能由這一輪產生/)).toBeTruthy();
  });

  it("opening an older turn's file adds a closable tab", () => {
    const units = turns(2);
    units[0].files = [{ id: 'old-f', kind: 'file', path: 'docs/old.md', content: '# Old', blocks: [] }];
    view(units);
    fireEvent.click(screen.getByRole('button', { name: 'old.md' }));
    const tab = screen.getByRole('tab', { name: /old\.md（第 1 輪）/ });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(stream().hidden).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '關閉 old.md' }));
    expect(screen.queryByRole('tab', { name: /old\.md/ })).toBeNull();
    expect(screen.getByRole('tab', { name: /對話/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('opening a latest-turn file selects its existing tab', () => {
    const units = turns(2);
    units[1].files = [{ id: 'new-f', kind: 'file', path: 'src/new.ts', content: 'x', blocks: [] }];
    view(units);
    fireEvent.click(screen.getByRole('button', { name: 'new.ts' }));
    expect(screen.getAllByRole('tab', { name: /new\.ts/ })).toHaveLength(1);
    expect(screen.getByRole('tab', { name: /new\.ts/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('keeps the stream position across tab switches', () => {
    const units = turns(10);
    units[9].files = [{ id: 'f', kind: 'file', path: 'a.ts', content: 'x', blocks: [] }];
    const onAnchorChange = vi.fn();
    view(units, { onAnchorChange });
    scrollTo(420);
    fireEvent.click(screen.getByRole('tab', { name: 'a.ts' }));
    onAnchorChange.mockClear();
    fireEvent.scroll(stream());
    expect(onAnchorChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('tab', { name: /對話/ }));
    expect(stream().scrollTop).toBe(420);
  });

  it('keeps the stream position after adding a file', async () => {
    const units = turns(10);
    const { rerender } = view(units);
    scrollTo(420);
    fireEvent.click(screen.getByRole('button', { name: /加入檔案/ }));
    fireEvent.change(screen.getByPlaceholderText(/檔案路徑/), { target: { value: 'src/added.ts' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '加入' }));
    });
    const latest = { ...units[9], files: [{ id: 'added', kind: 'file' as const, path: 'src/added.ts', content: 'x', blocks: [] }] };
    rerender(<ConversationView session={session} units={[...units.slice(0, 9), latest]} actionsFor={actionsFor} />);
    expect(screen.getByRole('tab', { name: 'added.ts' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: /對話/ }));
    expect(stream().scrollTop).toBe(420);
  });

  it('follows content added below while the reader sits at the bottom', () => {
    const observers: (() => void)[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          observers.push(cb);
        }
        observe() {}
        disconnect() {}
      },
    );
    view(turns(10));
    scrollTo(1050);
    extra = 200;
    act(() => observers.forEach((cb) => cb()));
    expect(stream().scrollTop).toBe(1250);
    scrollTo(500);
    extra = 400;
    act(() => observers.forEach((cb) => cb()));
    expect(stream().scrollTop).toBe(500);
  });

  it('renders the newest 30 turns and loads 30 more near the top', () => {
    view(turns(35));
    expect(sections()).toHaveLength(30);
    expect(sections()[0].dataset.unitId).toBe('u5');
    scrollTo(0);
    expect(sections()).toHaveLength(35);
    expect(stream().scrollTop).toBe(500);
  });

  it('loads earlier turns from the start button', () => {
    view(turns(35));
    fireEvent.click(screen.getByRole('button', { name: '載入更早的對話' }));
    expect(sections()).toHaveLength(35);
  });

  it('scrolls to bottom on mount', () => {
    view(turns(10));
    expect(stream().scrollTop).toBe(10 * 100 + 50);
  });

  it('follows a new turn when at the bottom', () => {
    const units = turns(10);
    const { rerender } = view(units);
    rerender(<ConversationView session={session} units={[...units, turn(10)]} actionsFor={actionsFor} />);
    expect(stream().scrollTop).toBe(11 * 100 + 50);
    expect(screen.queryByRole('button', { name: /新回覆/ })).toBeNull();
  });

  it("keeps the reader's text in place when a new turn arrives while scrolled up", () => {
    const units = turns(35);
    const { rerender } = view(units);
    scrollTo(800);
    const first = sections()[0].dataset.unitId;
    rerender(<ConversationView session={session} units={[...units, turn(35)]} actionsFor={actionsFor} />);
    expect(sections()[0].dataset.unitId).toBe(first);
    expect(stream().scrollTop).toBe(800);
    fireEvent.click(screen.getByRole('button', { name: /新回覆/ }));
    expect(stream().scrollTop).toBe(31 * 100 + 50);
    expect(screen.queryByRole('button', { name: /新回覆/ })).toBeNull();
  });

  it('stays pinned to the bottom while content grows', () => {
    const observers: (() => void)[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          observers.push(cb);
        }
        observe() {}
        disconnect() {}
      },
    );
    view(turns(10));
    extra = 400;
    act(() => observers.forEach((cb) => cb()));
    expect(stream().scrollTop).toBe(1050 + 400);
    scrollTo(300);
    extra = 800;
    act(() => observers.forEach((cb) => cb()));
    expect(stream().scrollTop).toBe(300);
  });

  it('restores the initial anchor', () => {
    view(turns(40), { initialAnchor: { unitId: 'u3', offset: 20 } });
    const u3 = sections().find((s) => s.dataset.unitId === 'u3')!;
    expect(stream().scrollTop).toBe(u3.offsetTop + 20);
  });

  it('scrolls to bottom when the initial anchor is gone', () => {
    view(turns(5), { initialAnchor: { unitId: 'gone', offset: 0 } });
    expect(stream().scrollTop).toBe(550);
  });

  it('reports the anchor while scrolling the stream', () => {
    vi.useFakeTimers();
    try {
      const onAnchorChange = vi.fn();
      view(turns(10), { onAnchorChange });
      scrollTo(270);
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(onAnchorChange).toHaveBeenLastCalledWith({ unitId: 'u2', offset: 20 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the responding banner after the last turn', () => {
    const responding: SessionActivity = { sessionId: 'sess-1', agent: 'claude', cwd: 'C:/work', since: new Date().toISOString(), lastChange: new Date().toISOString(), prompt: '下一步' };
    view(turns(2), { responding });
    const banner = document.querySelector('.banner-responding')!;
    expect(banner).toBeTruthy();
    expect(sections()[1].compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the pending prompt for a session without replies', () => {
    const responding: SessionActivity = { sessionId: 'sess-1', agent: 'codex', cwd: 'C:/work', since: new Date().toISOString(), lastChange: new Date().toISOString(), prompt: '第一個問題' };
    view([], { responding });
    expect(screen.getByText('第一個問題')).toBeTruthy();
    expect(document.querySelector('.banner-responding')).toBeTruthy();
  });

  it('shows the project and worktree in the header', () => {
    view(turns(1), { session: { ...session, project: { key: 'c:/work', root: 'C:/work', worktree: 'feat-x' } } });
    const head = document.querySelector('.conversation-head')!;
    expect(head.textContent).toContain('work');
    expect(head.textContent).toContain('feat-x');
  });
});
