// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { ConclusionBar } from '../../src/web/components/ConclusionBar.js';
import { anchorOn, makeThread, makeUnit, renderInUnit } from './fixtures.js';

afterEach(cleanup);

describe('ConclusionBar', () => {
  it('ConclusionBar disables submit while any thread unresolved', () => {
    const unit = makeUnit();
    const a = anchorOn(unit);
    unit.threads = [
      makeThread('t1', a, { status: 'resolved', conclusion: 'Keep it.' }),
      makeThread('t2', a, { status: 'resolved', conclusion: 'Rename it.' }),
      // A nested child that is still open must also block submission.
      makeThread('t3', { ...a, sourceId: 'msg:m1' }, { parentThreadId: 't2', status: 'awaiting' }),
    ];
    renderInUnit(<ConclusionBar />, unit);
    expect(screen.getByRole('button', { name: '送出結論' })).toHaveProperty('disabled', true);
  });

  it('ConclusionBar enables submit when all resolved', () => {
    const unit = makeUnit();
    const a = anchorOn(unit);
    unit.threads = [
      makeThread('t1', a, { status: 'resolved', conclusion: 'Keep it.' }),
      makeThread('t2', a, { status: 'resolved', conclusion: null, noConclusion: true }),
    ];
    renderInUnit(<ConclusionBar />, unit);
    expect(screen.getByRole('button', { name: '送出結論' })).toHaveProperty('disabled', false);
  });

  it('counts top-level threads in the preview counter', () => {
    const unit = makeUnit();
    const a = anchorOn(unit);
    unit.threads = [
      makeThread('t1', a, { status: 'resolved', conclusion: 'Keep it.' }),
      makeThread('t2', a, { status: 'awaiting' }),
      makeThread('t3', { ...a, sourceId: 'msg:m1' }, { parentThreadId: 't2', status: 'resolved', conclusion: 'x' }),
    ];
    renderInUnit(<ConclusionBar />, unit);
    expect(screen.getByRole('button', { name: /結論預覽（1\/2）/ })).toBeTruthy();
  });

  it('shows the Claude delivery hint after submit', () => {
    const unit = makeUnit({ status: 'submitted' });
    unit.threads = [makeThread('t1', anchorOn(unit), { status: 'resolved', conclusion: 'Keep it.' })];
    renderInUnit(<ConclusionBar />, unit);
    expect(screen.getByText(/結論會自動帶入主對話/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '送出結論' })).toHaveProperty('disabled', true);
  });
});
