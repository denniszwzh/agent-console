// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import type { ReviewUnit, SessionSummary } from '../../src/shared/types.js';
import { VIEW_STATE_KEY } from '../../src/web/view-state.js';
import { makeUnit } from './fixtures.js';

const sessions: SessionSummary[] = [
  { sessionId: 's1', agent: 'claude', cwd: 'C:/a', lastActivity: '2026-11-16T05:00:00.000Z', title: 'one' },
  { sessionId: 's2', agent: 'codex', cwd: 'C:/b', lastActivity: '2026-11-16T04:00:00.000Z', title: 'two' },
];
const unitsOf = (sid: string): ReviewUnit[] =>
  Array.from({ length: 10 }, (_, i) =>
    makeUnit({ id: `${sid}-u${i}`, sessionId: sid, createdAt: new Date(Date.UTC(2026, 10, 16, 0, i)).toISOString(), status: i === 9 ? 'open' : 'stale' }),
  );
let unitsGate: Record<string, Promise<void>> = {};

vi.mock('../../src/web/api.js', async (orig) => ({
  ...(await orig<typeof import('../../src/web/api.js')>()),
  api: {
    sessions: async () => sessions,
    activity: async () => [],
    units: async (sid: string) => {
      await unitsGate[sid];
      return unitsOf(sid);
    },
  },
  subscribeEvents: () => () => {},
}));

const { App } = await import('../../src/web/App.js');

// Layout stand-ins (see conversation-view.test.tsx): turns are 100px tall, the stream shows 300px.
const saved: [string, PropertyDescriptor | undefined][] = [];
function define(name: string, get: (this: HTMLElement) => number) {
  saved.push([name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)]);
  Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get });
}
beforeAll(() => {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  define('scrollHeight', function () {
    return this.querySelectorAll('section.turn').length * 100 + 50;
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
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  unitsGate = {};
});
afterEach(cleanup);

const store = (v: unknown) => localStorage.setItem(VIEW_STATE_KEY, JSON.stringify(v));
const current = () => document.querySelector('.session[aria-current="true"], .session.selected .session-project')?.textContent;
const stream = () => document.querySelector<HTMLElement>('.stream');

describe('App view restore', () => {
  it('restores the saved session', async () => {
    store({ session: 's2', anchor: null });
    render(<App />);
    await waitFor(() => expect(document.querySelector('.session.selected .session-project')?.textContent).toBe('two'));
  });

  it('falls back when the saved session is gone', async () => {
    store({ session: 'gone', anchor: null });
    render(<App />);
    await waitFor(() => expect(document.querySelector('.session.selected .session-project')?.textContent).toBe('one'));
  });

  it("restores after the session's units arrive", async () => {
    let release!: () => void;
    unitsGate.s2 = new Promise((r) => (release = r));
    store({ session: 's2', anchor: { unitId: 's2-u3', offset: 20 } });
    render(<App />);
    await waitFor(() => expect(document.querySelector('.session.selected .session-project')?.textContent).toBe('two'));
    expect(stream()).toBeNull();
    release();
    await waitFor(() => expect(stream()?.scrollTop).toBe(50 + 3 * 100 + 20));
  });

  it('scrolls to bottom when the saved turn is gone', async () => {
    store({ session: 's1', anchor: { unitId: 'gone', offset: 0 } });
    render(<App />);
    await waitFor(() => expect(stream()?.scrollTop).toBe(10 * 100 + 50));
  });

  it('keeps the stored anchor until the user scrolls', async () => {
    store({ session: 's1', anchor: { unitId: 's1-u2', offset: 5 } });
    render(<App />);
    await waitFor(() => expect(stream()?.scrollTop).toBe(50 + 2 * 100 + 5));
    expect(JSON.parse(localStorage.getItem(VIEW_STATE_KEY)!)).toEqual({ session: 's1', anchor: { unitId: 's1-u2', offset: 5 } });
    void current;
  });
});
