import { describe, expect, it } from 'vitest';
import { integrationState, isExcluded } from '../../src/shared/gate.js';
import type { ReviewUnit, Thread, ThreadStatus } from '../../src/shared/types.js';

const thread = (id: string, status: ThreadStatus): Thread => ({
  id,
  unitId: 'u',
  parentThreadId: null,
  anchor: { sourceId: 'r', blockId: 'b', quote: 'q', headingPath: [], startLine: 1, endLine: 1 },
  forkFromSessionId: 's',
  sessionId: 'f',
  status,
  messages: [],
  conclusion: null,
  noConclusion: false,
});

const unit = (statuses: ThreadStatus[], over: Partial<ReviewUnit> = {}): ReviewUnit => ({
  id: 'u',
  agent: 'claude',
  sessionId: 's',
  cwd: 'C:/w',
  createdAt: '2026-11-17T00:00:00.000Z',
  reply: { id: 'r', kind: 'reply', content: '', blocks: [] },
  files: [],
  threads: statuses.map((s, i) => thread(`t${i}`, s)),
  status: 'open',
  delivered: false,
  warnings: [],
  ...over,
});

describe('isExcluded', () => {
  it('leaves drafts, failed and expired threads out of the conclusions', () => {
    expect(['draft', 'error', 'expired'].map((s) => isExcluded(thread('t', s as ThreadStatus)))).toEqual([true, true, true]);
    expect(['answering', 'awaiting', 'resolved'].map((s) => isExcluded(thread('t', s as ThreadStatus)))).toEqual([false, false, false]);
  });
});

describe('integrationState', () => {
  it('can integrate once every thread has its answer', () => {
    expect(integrationState(unit(['awaiting', 'resolved', 'error', 'draft']))).toEqual({
      answering: 0,
      answered: 2,
      concluded: 1,
      total: 2,
      canIntegrate: true,
    });
  });

  it('cannot integrate while a thread is answering', () => {
    expect(integrationState(unit(['awaiting', 'answering']))).toMatchObject({ answering: 1, answered: 1, total: 2, canIntegrate: false });
  });

  it('cannot integrate without an answered thread, outside an open unit, or while integrating', () => {
    expect(integrationState(unit([])).canIntegrate).toBe(false);
    expect(integrationState(unit(['error', 'draft'])).canIntegrate).toBe(false);
    expect(integrationState(unit(['awaiting'], { status: 'stale' })).canIntegrate).toBe(false);
    expect(integrationState(unit(['awaiting'], { status: 'submitted' })).canIntegrate).toBe(false);
    expect(integrationState(unit(['awaiting'], { integrating: true })).canIntegrate).toBe(false);
  });
});
