import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { splitBlocks } from '../../src/shared/blocks.js';
import type { Anchor, Message, ReviewUnit, Thread } from '../../src/shared/types.js';
import { UnitProvider, type UnitActions } from '../../src/web/unit-context.js';

export function makeUnit(over: Partial<ReviewUnit> = {}): ReviewUnit {
  const content = '# Plan\n\nFirst paragraph.\n\nSecond paragraph.';
  return {
    id: 'unit-1',
    agent: 'claude',
    sessionId: 'sess-1',
    cwd: 'C:/work',
    createdAt: '2026-11-15T10:00:00.000Z',
    reply: { id: 'reply-1', kind: 'reply', content, blocks: splitBlocks(content, 'markdown') },
    files: [],
    threads: [],
    status: 'open',
    delivered: false,
    warnings: [],
    ...over,
  };
}

export function anchorOn(unit: ReviewUnit, blockIndex = 1): Anchor {
  const b = unit.reply.blocks[blockIndex];
  return { sourceId: unit.reply.id, blockId: b.id, quote: b.text, headingPath: b.headingPath, startLine: b.startLine, endLine: b.endLine };
}

export function assistant(id: string, content: string): Message {
  return { id, role: 'assistant', content, createdAt: '', blocks: splitBlocks(content, 'markdown') };
}

export function makeThread(id: string, anchor: Anchor, over: Partial<Thread> = {}): Thread {
  return {
    id,
    unitId: 'unit-1',
    parentThreadId: null,
    anchor,
    forkFromSessionId: 'sess-1',
    sessionId: `fork-${id}`,
    status: 'awaiting',
    messages: [{ id: `${id}-q`, role: 'user', content: `Question ${id}?`, createdAt: '' }],
    conclusion: null,
    noConclusion: false,
    ...over,
  };
}

export function fakeActions(): UnitActions {
  return {
    addThread: vi.fn(async () => {}),
    deleteThread: vi.fn(async () => {}),
    sendDrafts: vi.fn(async () => {}),
    followUp: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
    resolve: vi.fn(async () => {}),
    setConclusion: vi.fn(async () => {}),
    submit: vi.fn(async () => {}),
    addFile: vi.fn(async () => {}),
  };
}

export function renderInUnit(ui: ReactElement, unit: ReviewUnit, actions = fakeActions()) {
  return render(
    <UnitProvider unit={unit} actions={actions}>
      {ui}
    </UnitProvider>,
  );
}
