// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { ConclusionBar } from '../../src/web/components/ConclusionBar.js';
import { anchorOn, fakeActions, makeThread, makeUnit, renderInUnit } from './fixtures.js';

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

  it('shows a pending state while the submit request is in flight', async () => {
    const unit = makeUnit();
    unit.threads = [makeThread('t1', anchorOn(unit), { status: 'resolved', conclusion: 'Keep it.' })];
    let finish!: () => void;
    const actions = fakeActions();
    actions.submit = vi.fn(() => new Promise<void>((r) => (finish = r)));
    renderInUnit(<ConclusionBar />, unit, actions);
    fireEvent.click(screen.getByRole('button', { name: '送出結論' }));
    const pending = await screen.findByRole('button', { name: '送出中…' });
    expect(pending).toHaveProperty('disabled', true);
    expect(screen.getByRole('status').textContent).toBe('正在送出結論…');
    finish();
    await screen.findByRole('button', { name: '送出結論' });
    expect(screen.queryByRole('status')).toBeNull();
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
