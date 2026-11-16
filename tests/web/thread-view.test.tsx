// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { ThreadView } from '../../src/web/components/ThreadView.js';
import { UnitProvider } from '../../src/web/unit-context.js';
import { anchorOn, assistant, fakeActions, makeThread, makeUnit, renderInUnit } from './fixtures.js';

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
    expect(screen.getByText('Draft')).toBeTruthy();
    expect(screen.getAllByText('Answered')).toHaveLength(2);
  });

  it('an answered thread offers only a follow-up', () => {
    const unit = makeUnit();
    const t = makeThread('t1', anchorOn(unit));
    unit.threads = [t];
    renderInUnit(<ThreadView thread={t} />, unit);
    expect(screen.getByRole('button', { name: 'Follow up' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '結束此串' })).toBeNull();
  });

  it('a leftover draft can be sent or deleted', () => {
    const unit = makeUnit();
    const t = makeThread('t1', anchorOn(unit), { status: 'draft', sessionId: null });
    unit.threads = [t];
    const actions = fakeActions();
    renderInUnit(<ThreadView thread={t} />, unit, actions);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(actions.sendThread).toHaveBeenCalledWith('t1');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(actions.deleteThread).toHaveBeenCalledWith('t1');
  });

  it('nothing can be changed while conclusions are being integrated', () => {
    const unit = makeUnit();
    const t = makeThread('t1', anchorOn(unit));
    unit.threads = [t];
    const actions = fakeActions();
    const { rerender } = renderInUnit(<ThreadView thread={t} />, unit, actions);
    expect(screen.getByRole('button', { name: 'Follow up' })).toBeTruthy();
    rerender(
      <UnitProvider unit={{ ...unit, integrating: true }} actions={actions}>
        <ThreadView thread={t} />
      </UnitProvider>,
    );
    expect(screen.getByText('Question t1?')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Follow up' })).toBeNull();
  });

  it('a concluded thread shows its conclusion', () => {
    const unit = makeUnit();
    const t = makeThread('t1', anchorOn(unit), { status: 'resolved', conclusion: 'Keep it.' });
    unit.threads = [t];
    renderInUnit(<ThreadView thread={t} />, unit);
    expect(screen.getByText('Concluded')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Expand/ }));
    expect(screen.getByText('Keep it.')).toBeTruthy();
  });

  it('shows the error with a retry button', () => {
    const unit = makeUnit();
    const t = makeThread('t1', anchorOn(unit), { status: 'error', error: 'boom' });
    unit.threads = [t];
    renderInUnit(<ThreadView thread={t} />, unit);
    expect(screen.getByText('Error')).toBeTruthy();
    expect(screen.getByText(/boom/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
