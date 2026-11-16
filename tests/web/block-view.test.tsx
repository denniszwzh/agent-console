// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { splitBlocks } from '../../src/shared/blocks.js';
import { TurnView } from '../../src/web/components/TurnView.js';
import { fakeActions, makeUnit } from './fixtures.js';

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  cleanup();
});

/** Select `length` characters at the start of the element's first text node and release the mouse. */
function selectStartOf(el: HTMLElement, length: number) {
  const text = el.firstChild as Text;
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, length);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  fireEvent.mouseUp(el);
}

describe('BlockView selection questions', () => {
  it('asks about the selected text with the composer focused', async () => {
    const unit = makeUnit();
    const actions = fakeActions();
    render(<TurnView unit={unit} actions={actions} latest turnNumber={1} onOpenFile={() => {}} />);
    selectStartOf(screen.getByText('First paragraph.'), 5);
    fireEvent.click(screen.getByTitle('針對選取的文字提問'));
    const textarea = screen.getByPlaceholderText('針對這段提出問題…');
    expect(document.activeElement).toBe(textarea);
    fireEvent.change(textarea, { target: { value: 'Why first?' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '送出' }));
    });
    const block = unit.reply.blocks[1];
    expect(actions.addThread).toHaveBeenCalledWith(
      { sourceId: 'reply-1', blockId: block.id, quote: 'First', headingPath: ['Plan'], startLine: block.startLine, endLine: block.endLine },
      'Why first?',
      undefined,
    );
  });

  it('hides the selection button once the selection collapses', () => {
    render(<TurnView unit={makeUnit()} actions={fakeActions()} latest turnNumber={1} onOpenFile={() => {}} />);
    selectStartOf(screen.getByText('First paragraph.'), 5);
    expect(screen.queryByTitle('針對選取的文字提問')).not.toBeNull();
    act(() => {
      window.getSelection()!.removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(screen.queryByTitle('針對選取的文字提問')).toBeNull();
  });

  it('requests local images together with the source that references them', () => {
    const content = 'See ![flow](img/flow.png)';
    const unit = makeUnit({ reply: { id: 'reply-1', kind: 'reply', content, blocks: splitBlocks(content, 'markdown') } });
    const { container } = render(<TurnView unit={unit} actions={fakeActions()} latest turnNumber={1} onOpenFile={() => {}} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      '/api/units/unit-1/image?source=reply-1&path=img%2Fflow.png',
    );
  });

  it('numbers each ordered list item by its position in the list', () => {
    const content = '1. one\n1. two\n1. three';
    const unit = makeUnit({ reply: { id: 'reply-1', kind: 'reply', content, blocks: splitBlocks(content, 'markdown') } });
    const { container } = render(<TurnView unit={unit} actions={fakeActions()} latest turnNumber={1} onOpenFile={() => {}} />);
    const lists = [...container.querySelectorAll('ol')];
    expect(lists.map((ol) => ol.getAttribute('start') ?? '1')).toEqual(['1', '2', '3']);
    expect(lists.map((ol) => ol.textContent?.trim())).toEqual(['one', 'two', 'three']);
  });
});
