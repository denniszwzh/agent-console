// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { RespondingBanner, formatElapsed } from '../../src/web/components/Responding.js';
import { Sidebar } from '../../src/web/components/Sidebar.js';
import type { SessionActivity } from '../../src/shared/types.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const T0 = Date.parse('2026-11-16T10:00:00.000Z');
const activity = (over: Partial<SessionActivity> = {}): SessionActivity => ({
  sessionId: 's1',
  agent: 'claude',
  cwd: 'C:\\proj',
  since: new Date(T0).toISOString(),
  lastChange: new Date(T0).toISOString(),
  prompt: 'explain the cache',
  ...over,
});

describe('formatElapsed', () => {
  it('formats m:ss and h:mm:ss and never goes negative', () => {
    const iso = new Date(T0).toISOString();
    expect(formatElapsed(iso, T0 + 5_000)).toBe('0:05');
    expect(formatElapsed(iso, T0 + 125_000)).toBe('2:05');
    expect(formatElapsed(iso, T0 + 3_725_000)).toBe('1:02:05');
    expect(formatElapsed(iso, T0 - 10_000)).toBe('0:00');
  });
});

describe('RespondingBanner', () => {
  it('shows the prompt and a ticking elapsed time', () => {
    vi.useFakeTimers({ now: T0 + 61_000 });
    render(<RespondingBanner activity={activity()} />);
    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain('主對話正在回應');
    expect(banner.textContent).toContain('已 1:01');
    expect(banner.textContent).toContain('「explain the cache」');
    expect(banner.textContent).toContain('完成後新的回覆會自動出現在這裡');
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(banner.textContent).toContain('已 1:03');
  });

  it('reminds to integrate before the next reply, and says when the session has gone quiet', () => {
    vi.useFakeTimers({ now: T0 + 4 * 60_000 });
    render(<RespondingBanner activity={activity()} unitOpen />);
    const text = screen.getByRole('status').textContent ?? '';
    expect(text).toContain('已經 4 分鐘沒有新動靜');
    expect(text).toContain('整合結論');
  });
});

describe('Sidebar responding badge', () => {
  it('marks only the responding sessions', () => {
    render(
      <Sidebar
        sessions={[
          { sessionId: 's1', agent: 'claude', cwd: 'C:\\a', lastActivity: new Date(T0).toISOString() },
          { sessionId: 's2', agent: 'codex', cwd: 'C:\\b', lastActivity: new Date(T0).toISOString() },
        ]}
        responding={new Set(['s1'])}
        unitsBySession={{}}
        selectedSession={null}
        selectedUnit={null}
        onSelect={() => {}}
      />,
    );
    const badges = screen.getAllByTitle('主對話正在回應');
    expect(badges).toHaveLength(1);
    expect(badges[0].closest('li')?.querySelector('.session-project')?.textContent).toBe('a');
    expect(badges[0].closest('li')?.textContent).not.toContain('codex');
  });
});
