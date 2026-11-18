import { describe, expect, it } from 'vitest';
import type { ReviewUnit, ThreadStatus } from '../../src/shared/types.js';
import { detectCompletions, stackCompletions, threadChain, type Completion } from '../../src/web/notifications.js';
import { anchorOn, makeThread, makeUnit } from './fixtures.js';

const NOW = 1_000;

function unitWith(status: ThreadStatus, over: Partial<ReviewUnit> = {}): ReviewUnit {
  const base = makeUnit();
  return makeUnit({ threads: [makeThread('t1', anchorOn(base), { status })], ...over });
}

describe('detectCompletions', () => {
  it('reports nothing on the first load', () => {
    expect(detectCompletions(undefined, [makeUnit()], NOW)).toEqual([]);
  });

  it('reports a new reply with its last prompt', () => {
    const next = makeUnit({ id: 'unit-2', prompts: [{ text: 'older', at: '' }, { text: 'Fix the bug\nplease', at: '' }] });
    expect(detectCompletions([makeUnit()], [makeUnit(), next], NOW)).toEqual([
      { key: 'reply:unit-2', kind: 'reply', sessionId: 'sess-1', unitId: 'unit-2', text: 'Fix the bug', at: NOW },
    ]);
  });

  it('skips the delivery prompt and falls back to the reply text', () => {
    const next = makeUnit({ id: 'unit-2', prompts: [{ text: 'apply conclusions', at: '', delivery: true }] });
    expect(detectCompletions([], [next], NOW)[0].text).toBe('Plan');
  });

  it('reports a thread that finished answering, with its latest question', () => {
    const before = unitWith('answering');
    const after = unitWith('awaiting');
    after.threads[0].messages.push({ id: 'f', role: 'user', content: 'And the follow-up?', createdAt: '' });
    expect(detectCompletions([before], [after], NOW)).toEqual([
      { key: 'thread:t1', kind: 'thread', sessionId: 'sess-1', unitId: 'unit-1', threadId: 't1', failed: undefined, text: 'And the follow-up?', at: NOW },
    ]);
  });

  it('marks a thread run that failed', () => {
    const [c] = detectCompletions([unitWith('answering')], [unitWith('error')], NOW);
    expect(c.failed).toBe(true);
  });

  it('reports a run that ended before it was seen answering', () => {
    expect(detectCompletions([unitWith('draft')], [unitWith('error')], NOW)).toHaveLength(1);
    expect(detectCompletions([makeUnit()], [unitWith('awaiting')], NOW)).toHaveLength(1);
  });

  it('ignores other status changes', () => {
    expect(detectCompletions([unitWith('draft')], [unitWith('answering')], NOW)).toEqual([]);
    expect(detectCompletions([unitWith('awaiting')], [unitWith('awaiting')], NOW)).toEqual([]);
    expect(detectCompletions([unitWith('answering')], [unitWith('expired')], NOW)).toEqual([]);
    // A concluded thread reopened because a child thread was added under it.
    expect(detectCompletions([unitWith('resolved')], [unitWith('awaiting')], NOW)).toEqual([]);
  });

  it('ignores conclusion runs while integrating', () => {
    expect(detectCompletions([unitWith('answering', { integrating: true })], [unitWith('awaiting', { integrating: true })], NOW)).toEqual([]);
    expect(detectCompletions([unitWith('answering', { integrating: true })], [unitWith('awaiting')], NOW)).toEqual([]);
  });
});

describe('stackCompletions', () => {
  const c = (key: string, at: number): Completion => ({ key, kind: 'thread', sessionId: 's', unitId: 'u', text: key, at });

  it('appends new items and keeps one card per key, moved to the top', () => {
    const stack = [c('a', 1), c('b', 2)];
    expect(stackCompletions(stack, [c('a', 3), c('d', 3)]).map((x) => `${x.key}${x.at}`)).toEqual(['b2', 'a3', 'd3']);
  });

  it('returns the same stack when nothing was added', () => {
    const stack = [c('a', 1)];
    expect(stackCompletions(stack, [])).toBe(stack);
  });
});

describe('threadChain', () => {
  it('lists the thread and its ancestors, innermost first', () => {
    const base = makeUnit();
    const unit = makeUnit({
      threads: [
        makeThread('root', anchorOn(base)),
        makeThread('mid', anchorOn(base), { parentThreadId: 'root' }),
        makeThread('leaf', anchorOn(base), { parentThreadId: 'mid' }),
      ],
    });
    expect(threadChain(unit, 'leaf')).toEqual(['leaf', 'mid', 'root']);
    expect(threadChain(unit, 'missing')).toEqual([]);
  });
});
