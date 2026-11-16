// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TurnView } from '../../src/web/components/TurnView.js';
import type { ReviewUnit, TurnPrompt } from '../../src/shared/types.js';
import { anchorOn, fakeActions, makeThread, makeUnit } from './fixtures.js';

afterEach(cleanup);

const prompt = (text: string, over: Partial<TurnPrompt> = {}): TurnPrompt => ({ text, at: '2026-11-15T09:59:00.000Z', ...over });
const view = (unit: ReviewUnit, over: { latest?: boolean; onOpenFile?: (u: string, s: string) => void } = {}) =>
  render(<TurnView unit={unit} actions={fakeActions()} latest={over.latest ?? true} turnNumber={3} onOpenFile={over.onOpenFile ?? (() => {})} />);

describe('TurnView', () => {
  it('shows the prompts before the reply', () => {
    const { container } = view(makeUnit({ prompts: [prompt('幫我寫計畫')] }));
    const section = container.querySelector('section.turn')!;
    expect(section.getAttribute('data-unit-id')).toBe('unit-1');
    const text = section.textContent!;
    expect(text).toContain('你：');
    expect(text.indexOf('幫我寫計畫')).toBeLessThan(text.indexOf('First paragraph.'));
  });

  it('shows no prompt area without prompts', () => {
    const { container } = view(makeUnit({ prompts: [] }));
    expect(container.querySelector('.turn-prompts')).toBeNull();
  });

  it('shows the count of omitted earlier prompts', () => {
    view(makeUnit({ prompts: [prompt('a'), prompt('b')], promptsOmitted: 2 }));
    expect(screen.getByText('還有 2 則較早的提問')).toBeTruthy();
  });

  it('folds a long prompt', () => {
    const long = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    const { container } = view(makeUnit({ prompts: [prompt(long)] }));
    expect(container.textContent).toContain('line 12');
    expect(container.textContent).not.toContain('line 20');
    fireEvent.click(screen.getByRole('button', { name: '展開' }));
    expect(container.textContent).toContain('line 20');
  });

  it('shows the delivery instruction as a marker', () => {
    const { container } = view(makeUnit({ prompts: [prompt('Read the review conclusions in C:\\x.md and apply them.', { delivery: true })] }));
    expect(container.textContent).not.toContain('Read the review conclusions');
    fireEvent.click(screen.getByRole('button', { name: /帶入審查結論/ }));
    expect(container.textContent).toContain('Read the review conclusions');
  });

  it('old turn has no ask buttons and no stale banner', () => {
    const unit = makeUnit({ status: 'stale' });
    unit.threads = [makeThread('t1', anchorOn(unit), { status: 'expired' })];
    view(unit, { latest: false });
    expect(screen.queryAllByRole('button', { name: '提問' })).toHaveLength(0);
    expect(screen.queryByText('已過期：主對話已進入下一輪')).toBeNull();
    expect(screen.getAllByText('已過期').length).toBeGreaterThan(0);
  });

  it('open latest turn offers ask buttons', () => {
    const unit = makeUnit();
    view(unit);
    expect(screen.getAllByRole('button', { name: '提問' })).toHaveLength(unit.reply.blocks.length);
  });

  it('lists changed files and opens one', () => {
    const onOpenFile = vi.fn();
    const unit = makeUnit({ files: [{ id: 'f1', kind: 'file', path: 'src/x.ts', content: 'x', blocks: [] }] });
    view(unit, { onOpenFile });
    fireEvent.click(screen.getByRole('button', { name: 'x.ts' }));
    expect(onOpenFile).toHaveBeenCalledWith('unit-1', 'f1');
  });

  it('shows warnings inside the turn', () => {
    view(makeUnit({ warnings: [{ at: '2026-11-15T10:01:00.000Z', threadId: 't1', paths: ['src/a.ts'] }] }));
    expect(screen.getByText(/問題串執行期間偵測到檔案變動/)).toBeTruthy();
    expect(screen.getByText('src/a.ts')).toBeTruthy();
  });

  it('shows the add-file hint only on the latest open turn', () => {
    const scanNotice = { omitted: 3, incomplete: false };
    view(makeUnit({ scanNotice }));
    expect(screen.queryByText(/加入檔案」加入/)).toBeTruthy();
    cleanup();
    view(makeUnit({ scanNotice, status: 'stale' }), { latest: false });
    expect(screen.queryByText(/這一輪還有 3 個/)).toBeTruthy();
    expect(screen.queryByText(/加入檔案」加入/)).toBeNull();
  });
});
