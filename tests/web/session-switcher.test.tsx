// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { SessionSwitcher, useHoldSwitcher } from '../../src/web/components/SessionSwitcher.js';
import { formatTime } from '../../src/web/labels.js';
import type { SessionActivity, SessionSummary } from '../../src/shared/types.js';
import { anchorOn, makeThread, makeUnit } from './fixtures.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const T0 = Date.parse('2026-11-16T10:00:00.000Z');
const ago = (ms: number) => new Date(T0 - ms).toISOString();

describe('useHoldSwitcher', () => {
  it('opens on Alt+S and closes when Alt is released', () => {
    const { result } = renderHook(() => useHoldSwitcher());
    const ev = new KeyboardEvent('keydown', { key: 's', code: 'KeyS', altKey: true, bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(ev);
    });
    expect(result.current.open).toBe(true);
    expect(ev.defaultPrevented).toBe(true);
    act(() => {
      fireEvent.keyUp(window, { key: 'Alt', code: 'AltLeft' });
    });
    expect(result.current.open).toBe(false);
  });

  it('ignores S without Alt and other Alt combos', () => {
    const { result } = renderHook(() => useHoldSwitcher());
    act(() => {
      fireEvent.keyDown(window, { key: 's', code: 'KeyS' });
      fireEvent.keyDown(window, { key: 'd', code: 'KeyD', altKey: true });
    });
    expect(result.current.open).toBe(false);
  });

  it('closes on Escape', () => {
    const { result } = renderHook(() => useHoldSwitcher());
    act(() => {
      fireEvent.keyDown(window, { key: 's', code: 'KeyS', altKey: true });
    });
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape', code: 'Escape', altKey: true });
    });
    expect(result.current.open).toBe(false);
  });

  it('closes on window blur', () => {
    const { result } = renderHook(() => useHoldSwitcher());
    act(() => {
      fireEvent.keyDown(window, { key: 's', code: 'KeyS', altKey: true });
    });
    act(() => {
      fireEvent.blur(window);
    });
    expect(result.current.open).toBe(false);
  });

  it('closes through close()', () => {
    const { result } = renderHook(() => useHoldSwitcher());
    act(() => {
      fireEvent.keyDown(window, { key: 's', code: 'KeyS', altKey: true });
    });
    act(() => result.current.close());
    expect(result.current.open).toBe(false);
  });
});

describe('SessionSwitcher', () => {
  const s1: SessionSummary = {
    sessionId: 's1',
    agent: 'claude',
    cwd: 'C:\\Projects\\stock',
    lastActivity: ago(3 * 3600_000),
    title: 'K棒反向交易功能',
    titleSource: 'agent',
    createdAt: '2026-11-15T01:12:00.000Z',
    lastModified: ago(5 * 60_000),
  };
  const s2: SessionSummary = { sessionId: 's2', agent: 'codex', cwd: 'C:\\Projects\\agent-console', lastActivity: ago(2 * 3600_000) };
  const responding = (since: string): SessionActivity => ({ sessionId: 's1', agent: 'claude', cwd: s1.cwd, since, lastChange: since });

  const rows = () => screen.getAllByRole('button').filter((b) => b.classList.contains('switcher-item'));

  it('lists sessions newest change first with details', () => {
    vi.useFakeTimers({ now: T0 });
    render(<SessionSwitcher sessions={[s2, s1]} unitsBySession={{}} activity={[]} selectedSession={null} onSelect={() => {}} />);
    const [first, second] = rows();
    expect(first.textContent).toContain('K棒反向交易功能');
    expect(first.textContent).toContain('C:\\Projects\\stock');
    expect(first.textContent).toContain(`建立 ${formatTime(s1.createdAt!)}`);
    expect(first.textContent).toContain('5 分鐘前');
    expect(second.textContent).toContain('agent-console');
    expect(second.textContent).toContain('2 小時前');
  });

  it('shows live status', () => {
    vi.useFakeTimers({ now: T0 });
    const u1 = makeUnit({ id: 'u1', sessionId: 's1' });
    u1.threads = [makeThread('t1', anchorOn(u1)), makeThread('t2', anchorOn(u1))];
    const u2 = makeUnit({ id: 'u2', sessionId: 's2', status: 'submitted' });
    u2.threads = [makeThread('t3', anchorOn(u2), { status: 'answering' })];
    const units = { s1: [u1], s2: [u2] };
    const { rerender } = render(
      <SessionSwitcher sessions={[s1, s2]} unitsBySession={units} activity={[responding(ago(83_000))]} selectedSession={null} onSelect={() => {}} />,
    );
    const [r1, r2] = rows();
    expect(r1.textContent).toContain('回應中');
    expect(r1.textContent).toContain('1:23');
    expect(r1.textContent).toContain('2 未結');
    expect(r1.textContent).toContain('審查中');
    expect(r2.textContent).toContain('問題串回答中');
    expect(r2.textContent).toContain('已送出');
    rerender(<SessionSwitcher sessions={[s1, s2]} unitsBySession={units} activity={[]} selectedSession={null} onSelect={() => {}} />);
    expect(rows()[0].textContent).not.toContain('回應中');
  });

  it('marks the current session and selects on click', () => {
    const onSelect = vi.fn();
    const older = makeUnit({ id: 'u-old', sessionId: 's1', createdAt: '2026-11-15T09:00:00.000Z' });
    const newer = makeUnit({ id: 'u-new', sessionId: 's1', createdAt: '2026-11-15T10:00:00.000Z' });
    render(
      <SessionSwitcher sessions={[s1, s2]} unitsBySession={{ s1: [older, newer] }} activity={[]} selectedSession="s2" onSelect={onSelect} />,
    );
    const [r1, r2] = rows();
    expect(r2.getAttribute('aria-current')).toBe('true');
    expect(r1.getAttribute('aria-current')).toBeNull();
    fireEvent.click(r1);
    expect(onSelect).toHaveBeenLastCalledWith('s1', 'u-new');
    fireEvent.click(r2);
    expect(onSelect).toHaveBeenLastCalledWith('s2', null);
  });

  it('refreshes relative times every minute', () => {
    vi.useFakeTimers({ now: T0 });
    render(<SessionSwitcher sessions={[s1]} unitsBySession={{}} activity={[]} selectedSession={null} onSelect={() => {}} />);
    expect(rows()[0].textContent).toContain('5 分鐘前');
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(rows()[0].textContent).toContain('6 分鐘前');
  });

  it('shows a first prompt as a softer title', () => {
    render(
      <SessionSwitcher
        sessions={[{ ...s2, title: '寫一份 docs/design.md', titleSource: 'prompt' }]}
        unitsBySession={{}}
        activity={[]}
        selectedSession={null}
        onSelect={() => {}}
      />,
    );
    const title = rows()[0].querySelector('.switcher-title')!;
    expect(title.textContent).toBe('寫一份 docs/design.md');
    expect(title.classList.contains('untitled')).toBe(true);
  });
});
