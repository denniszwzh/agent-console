// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { ReviewUnit, ServerEvent, SessionSummary } from '../../src/shared/types.js';
import { anchorOn, makeThread, makeUnit } from './fixtures.js';

let sessions: SessionSummary[] = [];
let unitsBy: Record<string, ReviewUnit[]> = {};
let emit: (e: ServerEvent) => void = () => {};

vi.mock('../../src/web/api.js', async (orig) => ({
  ...(await orig<typeof import('../../src/web/api.js')>()),
  api: {
    sessions: async () => sessions,
    activity: async () => [],
    units: async (sid: string) => unitsBy[sid] ?? [],
  },
  subscribeEvents: (onEvent: (e: ServerEvent) => void) => {
    emit = onEvent;
    return () => {};
  },
}));

const { App } = await import('../../src/web/App.js');

const session = (id: string, title: string): SessionSummary => ({ sessionId: id, agent: 'claude', cwd: `C:/${id}`, lastActivity: '2026-11-16T05:00:00.000Z', title });

beforeAll(() => {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
});
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  sessions = [session('s1', 'one'), session('s2', 'two')];
  unitsBy = { s1: [makeUnit({ id: 's1-u1', sessionId: 's1' })], s2: [makeUnit({ id: 's2-u1', sessionId: 's2' })] };
});
afterEach(cleanup);

const cards = () => [...document.querySelectorAll('.notification')];
const selectedTitle = () => document.querySelector('.session.selected .session-project')?.textContent;

async function event(e: ServerEvent) {
  await act(async () => {
    emit(e);
    // Events are coalesced for 150 ms before the refetch.
    await new Promise((r) => setTimeout(r, 200));
  });
}

describe('App completion notifications', () => {
  it('shows nothing for what was already there at load', async () => {
    render(<App />);
    await waitFor(() => expect(selectedTitle()).toBe('one'));
    expect(cards()).toHaveLength(0);
  });

  it('stacks a finished reply and a finished thread, and opens the session on click', async () => {
    const base = makeUnit();
    unitsBy.s1 = [makeUnit({ id: 's1-u1', sessionId: 's1', threads: [makeThread('t1', anchorOn(base), { status: 'answering' })] })];
    render(<App />);
    await waitFor(() => expect(selectedTitle()).toBe('one'));

    unitsBy.s2 = [...unitsBy.s2, makeUnit({ id: 's2-u2', sessionId: 's2', prompts: [{ text: 'Second prompt', at: '' }] })];
    await event({ type: 'unit.created', unitId: 's2-u2', sessionId: 's2' });
    unitsBy.s1 = [makeUnit({ id: 's1-u1', sessionId: 's1', threads: [makeThread('t1', anchorOn(base), { status: 'awaiting' })] })];
    await event({ type: 'unit.updated', unitId: 's1-u1', sessionId: 's1' });

    expect(cards().map((c) => c.querySelector('.notification-label')?.textContent)).toEqual(['Thread answered', 'Reply finished']);
    expect(cards()[1].textContent).toContain('Second prompt');

    fireEvent.click(cards()[1].querySelector('.notification-open')!);
    await waitFor(() => expect(selectedTitle()).toBe('two'));
    expect(cards()).toHaveLength(1);

    fireEvent.click(cards()[0].querySelector('.notification-close')!);
    expect(cards()).toHaveLength(0);
  });

  it('notifies the first reply of a session that appears after load', async () => {
    render(<App />);
    await waitFor(() => expect(selectedTitle()).toBe('one'));
    sessions = [...sessions, session('s3', 'three')];
    unitsBy.s3 = [makeUnit({ id: 's3-u1', sessionId: 's3' })];
    await event({ type: 'unit.created', unitId: 's3-u1', sessionId: 's3' });
    expect(cards()).toHaveLength(1);
    expect(cards()[0].textContent).toContain('three');
  });
});
