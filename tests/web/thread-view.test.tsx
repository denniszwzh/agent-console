// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { ThreadView } from '../../src/web/components/ThreadView.js';
import { anchorOn, assistant, makeThread, makeUnit, renderInUnit } from './fixtures.js';

afterEach(cleanup);

describe('ThreadView', () => {
  it('ThreadView renders nested child threads', () => {
    const unit = makeUnit();
    const answer = assistant('m1', 'Because of latency.\n\nAnd cost.');
    const parent = makeThread('t1', anchorOn(unit), {
      messages: [{ id: 'q1', role: 'user', content: 'Why not SSO?', createdAt: '' }, answer],
    });
    const childAnchor = {
      sourceId: 'msg:m1', blockId: answer.blocks![1].id, quote: 'And cost.', headingPath: [], startLine: 3, endLine: 3,
    };
    const answer2 = assistant('m2', 'Roughly ten dollars.');
    const child = makeThread('t2', childAnchor, {
      parentThreadId: 't1',
      messages: [{ id: 'q2', role: 'user', content: 'How much cost?', createdAt: '' }, answer2],
    });
    const grandchild = makeThread(
      't3',
      { sourceId: 'msg:m2', blockId: answer2.blocks![0].id, quote: 'Roughly ten dollars.', headingPath: [], startLine: 1, endLine: 1 },
      {
        parentThreadId: 't2',
        status: 'draft',
        sessionId: null,
        messages: [{ id: 'q3', role: 'user', content: 'Per month?', createdAt: '' }],
      },
    );
    unit.threads = [parent, child, grandchild];
    renderInUnit(<ThreadView thread={parent} />, unit);
    expect(screen.getByText('Why not SSO?')).toBeTruthy();
    expect(screen.getByText('Because of latency.')).toBeTruthy();
    expect(screen.getByText('How much cost?')).toBeTruthy();
    expect(screen.getByText('Roughly ten dollars.')).toBeTruthy();
    expect(screen.getByText('Per month?')).toBeTruthy();
    expect(screen.getByText('草稿')).toBeTruthy();
    expect(screen.getAllByText('等待追問')).toHaveLength(2);
  });

  it('shows the error with a retry button', () => {
    const unit = makeUnit();
    const t = makeThread('t1', anchorOn(unit), { status: 'error', error: 'boom' });
    unit.threads = [t];
    renderInUnit(<ThreadView thread={t} />, unit);
    expect(screen.getByText('錯誤')).toBeTruthy();
    expect(screen.getByText(/boom/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '重試' })).toBeTruthy();
  });
});
