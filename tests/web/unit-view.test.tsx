// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { UnitView } from '../../src/web/components/UnitView.js';
import { anchorOn, fakeActions, makeThread, makeUnit } from './fixtures.js';

afterEach(cleanup);

describe('UnitView', () => {
  it('open unit offers ask buttons on every block', () => {
    const unit = makeUnit();
    render(<UnitView unit={unit} actions={fakeActions()} />);
    expect(screen.getAllByRole('button', { name: '提問' })).toHaveLength(unit.reply.blocks.length);
  });

  it('stale unit hides ask buttons', () => {
    const unit = makeUnit({ status: 'stale' });
    unit.threads = [makeThread('t1', anchorOn(unit), { status: 'expired' })];
    render(<UnitView unit={unit} actions={fakeActions()} />);
    expect(screen.getByText('已過期：主對話已進入下一輪')).toBeTruthy();
    expect(screen.queryAllByRole('button', { name: '提問' })).toHaveLength(0);
    expect(screen.queryByRole('button', { name: '追問' })).toBeNull();
    expect(screen.queryByRole('button', { name: /加入檔案/ })).toBeNull();
    expect(screen.getAllByText('已過期').length).toBeGreaterThan(0);
  });

  it('unit warnings are shown with paths', () => {
    const unit = makeUnit({
      warnings: [{ at: '2026-11-15T10:01:00.000Z', threadId: 't1', paths: ['src/a.ts', 'docs/b.md'] }],
    });
    render(<UnitView unit={unit} actions={fakeActions()} />);
    expect(screen.getByText(/問題串執行期間偵測到檔案變動/)).toBeTruthy();
    expect(screen.getByText('src/a.ts')).toBeTruthy();
    expect(screen.getByText('docs/b.md')).toBeTruthy();
  });

  it('tabs show open thread counts per source', () => {
    const unit = makeUnit();
    unit.files = [{ id: 'f1', kind: 'file', path: 'src/x.ts', content: 'line one', blocks: [], language: 'ts' }];
    unit.threads = [
      makeThread('t1', anchorOn(unit)),
      makeThread('t2', anchorOn(unit), { status: 'resolved', conclusion: 'ok' }),
      makeThread('t3', { ...anchorOn(unit), sourceId: 'f1' }),
      makeThread('t4', { ...anchorOn(unit), sourceId: 'f1' }),
    ];
    render(<UnitView unit={unit} actions={fakeActions()} />);
    expect(screen.getByRole('tab', { name: /回覆\s*1/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /x\.ts\s*2/ })).toBeTruthy();
  });

  it('files found by the end-of-turn scan say how they were found; only guesses are marked on the tab', () => {
    const unit = makeUnit();
    unit.files = [
      { id: 'f1', kind: 'file', path: 'own.ts', content: 'a', blocks: [] },
      { id: 'f2', kind: 'file', path: 'shell.ts', content: 'b', blocks: [], detectedBy: 'git' },
      { id: 'f3', kind: 'file', path: 'guess.ts', content: 'c', blocks: [], detectedBy: 'mtime' },
    ];
    render(<UnitView unit={unit} actions={fakeActions()} />);
    expect(screen.getByRole('tab', { name: 'own.ts' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'shell.ts' })).toBeTruthy();
    const guessTab = () => screen.getByRole('tab', { name: /^guess\.ts\s*可能$/ });
    expect(guessTab()).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'shell.ts' }));
    expect(screen.getByText(/比對這一輪的 git 狀態找到的/)).toBeTruthy();
    expect(screen.queryByText(/可能由這一輪產生/)).toBeNull();

    fireEvent.click(guessTab());
    expect(screen.getByText(/可能由這一輪產生/)).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'own.ts' }));
    expect(screen.queryByText(/git 狀態|可能由這一輪產生/)).toBeNull();
  });

  it('shows how many scanned files were left out and an unfinished walk', () => {
    render(<UnitView unit={makeUnit({ scanNotice: { omitted: 7, incomplete: true } })} actions={fakeActions()} />);
    expect(screen.getByText(/還有 7 個變動的檔案沒有加入/)).toBeTruthy();
    expect(screen.getByText(/檔案掃描沒有做完/)).toBeTruthy();
    cleanup();
    render(<UnitView unit={makeUnit()} actions={fakeActions()} />);
    expect(screen.queryByText(/沒有加入|沒有做完/)).toBeNull();
  });
});
