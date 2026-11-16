// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { ConclusionBar } from '../../src/web/components/ConclusionBar.js';
import { anchorOn, fakeActions, makeThread, makeUnit, renderInUnit } from './fixtures.js';

afterEach(cleanup);

describe('ConclusionBar', () => {
  const integrate = () => screen.getByRole('button', { name: /整合/ });

  it('cannot integrate while a thread is answering, and says why', () => {
    const unit = makeUnit();
    const a = anchorOn(unit);
    unit.threads = [makeThread('t1', a), makeThread('t2', { ...a, sourceId: 'msg:m1' }, { parentThreadId: 't1', status: 'answering' })];
    renderInUnit(<ConclusionBar />, unit);
    expect(integrate()).toHaveProperty('disabled', true);
    expect(screen.getByText('還有 1 串正在回答')).toBeTruthy();
  });

  it('integrates once every thread has its answer; failed and unsent threads do not block', () => {
    const unit = makeUnit();
    const a = anchorOn(unit);
    unit.threads = [makeThread('t1', a), makeThread('t2', a, { status: 'error', error: 'x' }), makeThread('t3', a, { status: 'draft', sessionId: null })];
    const actions = fakeActions();
    renderInUnit(<ConclusionBar />, unit, actions);
    expect(screen.getByText('1 串已回答')).toBeTruthy();
    fireEvent.click(integrate());
    expect(actions.integrate).toHaveBeenCalledTimes(1);
  });

  it('cannot integrate without an answered thread', () => {
    const unit = makeUnit();
    renderInUnit(<ConclusionBar />, unit);
    expect(integrate()).toHaveProperty('disabled', true);
    expect(screen.getByText('還沒有已回答的問題串')).toBeTruthy();
  });

  it('shows the progress and stays disabled while integrating', () => {
    const unit = makeUnit({ integrating: true });
    const a = anchorOn(unit);
    unit.threads = [makeThread('t1', a, { status: 'resolved', conclusion: 'ok' }), makeThread('t2', a, { status: 'answering' })];
    renderInUnit(<ConclusionBar />, unit);
    expect(screen.getByRole('status').textContent).toBe('正在整合結論…（1/2）');
    expect(integrate()).toHaveProperty('disabled', true);
    expect(integrate().textContent).toBe('整合中…');
  });

  it('shows why the last integration stopped, and allows another try', () => {
    const unit = makeUnit({ integrationError: 'conclusion failed' });
    unit.threads = [makeThread('t1', anchorOn(unit))];
    renderInUnit(<ConclusionBar />, unit);
    expect(screen.getByRole('alert').textContent).toContain('conclusion failed');
    expect(integrate()).toHaveProperty('disabled', false);
  });

  it('after submitting, a thread under a failed thread is folded into its concluded ancestor', () => {
    const unit = makeUnit({ status: 'submitted' });
    const a = anchorOn(unit);
    unit.threads = [
      makeThread('t1', a, { status: 'resolved', conclusion: 'Top.' }),
      makeThread('t2', a, { parentThreadId: 't1', status: 'error' }),
      makeThread('t3', a, { parentThreadId: 't2', status: 'resolved', conclusion: 'Folded.' }),
    ];
    renderInUnit(<ConclusionBar />, unit);
    fireEvent.click(screen.getByRole('button', { name: /查看結論/ }));
    expect(screen.getByText('Top.')).toBeTruthy();
    expect(screen.queryByText('Folded.')).toBeNull();
  });

  it('after submitting, lists the conclusions read-only with the delivery hint', () => {
    const unit = makeUnit({ status: 'submitted' });
    const a = anchorOn(unit);
    unit.threads = [makeThread('t1', a, { status: 'resolved', conclusion: 'Keep it.' }), makeThread('t2', a, { status: 'error' })];
    renderInUnit(<ConclusionBar />, unit);
    expect(screen.getByText(/結論會自動帶入主對話/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /整合/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /查看結論/ }));
    expect(screen.getByText('Keep it.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '編輯' })).toBeNull();
    expect(screen.queryByRole('button', { name: '標記為無結論' })).toBeNull();
  });

  it('offers the Claude bundle path with a copy button as a fallback', async () => {
    const path = 'C:/Users/me/.agent-console/conclusions/unit-1.md';
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const unit = makeUnit({ status: 'submitted', conclusionsPath: path });
    unit.threads = [makeThread('t1', anchorOn(unit), { status: 'resolved', conclusion: 'Keep it.' })];
    renderInUnit(<ConclusionBar />, unit);
    expect(screen.getByText(path)).toBeTruthy();
    expect(screen.getByText(/\/clear/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '複製' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(path));
  });

  describe('Codex delivery', () => {
    const instruction = 'Read the review conclusions in C:/h/conclusions/u1.md and apply them.';
    const codexUnit = (queued: boolean) => {
      const unit = makeUnit({ agent: 'codex', status: 'submitted', delivery: { queued, instruction } });
      unit.threads = [makeThread('t1', anchorOn(unit), { status: 'resolved', conclusion: 'Keep it.' })];
      return unit;
    };

    it('always shows the copy button with the English instruction, and copies it', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      renderInUnit(<ConclusionBar />, codexUnit(false));
      expect(screen.queryByText('已送入佇列。')).toBeNull();
      expect(screen.getByText(instruction)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: '複製' }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(instruction));
      await screen.findByRole('button', { name: '已複製' });
    });

    it('also shows the queued notice when the queue accepted the message', () => {
      renderInUnit(<ConclusionBar />, codexUnit(true));
      expect(screen.getByText('已送入佇列；若下一輪沒有帶入，再複製下面的指令貼到 Codex。')).toBeTruthy();
      expect(screen.queryByText('貼到 Codex 對話即可套用結論：')).toBeNull();
      expect(screen.getByRole('button', { name: '複製' })).toBeTruthy();
    });

    it('shows a pending notice while the queue result is not known yet', () => {
      const unit = codexUnit(false);
      delete unit.delivery;
      renderInUnit(<ConclusionBar />, unit);
      expect(screen.getByText('正在送入 Codex 佇列…')).toBeTruthy();
    });
  });
});
