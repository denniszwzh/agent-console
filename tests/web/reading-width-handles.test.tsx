// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { ReadingWidthHandles } from '../../src/web/components/ReadingWidthHandles.js';
import type { ReadingWidth } from '../../src/web/reading-width.js';

/* jsdom has no layout: the stream is 1000px wide at x = 0, which is 62.5rem at the 16px root font size. */
function setup(width: ReadingWidth) {
  const stream = document.createElement('div');
  Object.defineProperty(stream, 'clientWidth', { configurable: true, get: () => 1000 });
  stream.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 500, width: 1000, height: 500, x: 0, y: 0, toJSON: () => ({}) });
  document.body.appendChild(stream);
  const streamRef = createRef<HTMLDivElement>() as { current: HTMLDivElement | null };
  streamRef.current = stream;
  const onAdjustStart = vi.fn();
  const onChange = vi.fn();
  render(<ReadingWidthHandles streamRef={streamRef} width={width} onAdjustStart={onAdjustStart} onChange={onChange} />);
  const [left, right] = screen.getAllByRole('separator');
  return { stream, left, right, onAdjustStart, onChange };
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('ReadingWidthHandles', () => {
  it('places the handles at the column edges', () => {
    const full = setup(null);
    expect([full.left.style.left, full.right.style.left]).toEqual(['0px', '994px']);
    cleanup();
    const narrow = setup(50);
    expect([narrow.left.style.left, narrow.right.style.left]).toEqual(['100px', '894px']);
  });

  it('dragging either handle changes the width symmetrically', () => {
    const { stream, right, onAdjustStart, onChange } = setup(null);
    fireEvent.pointerDown(right, { button: 0, pointerId: 1, pointerType: 'mouse', clientX: 1000 });
    fireEvent.pointerMove(right, { pointerId: 1, clientX: 900 });
    expect(stream.style.getPropertyValue('--reading-max')).toBe('50rem');
    expect(screen.getByText('50 rem')).toBeTruthy();
    fireEvent.pointerUp(right, { pointerId: 1 });
    expect(onAdjustStart).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(50);
    expect(stream.style.getPropertyValue('--reading-max')).toBe('');
    expect(screen.queryByText('50 rem')).toBeNull();
  });

  it('dragging past the edge shows full width but stores the visible width', () => {
    const { left, onChange } = setup(40);
    fireEvent.pointerDown(left, { button: 0, pointerId: 1, pointerType: 'mouse', clientX: 180 });
    fireEvent.pointerMove(left, { pointerId: 1, clientX: -200 });
    expect(screen.getByText('Full width')).toBeTruthy();
    fireEvent.pointerUp(left, { pointerId: 1 });
    expect(onChange).toHaveBeenCalledWith(62.5);
  });

  it('a click without moving changes nothing', () => {
    const { right, onChange } = setup(40);
    fireEvent.pointerDown(right, { button: 0, pointerId: 1, pointerType: 'mouse', clientX: 820 });
    fireEvent.pointerUp(right, { pointerId: 1 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('double-click returns to full width', () => {
    const { right, onAdjustStart, onChange } = setup(40);
    fireEvent.doubleClick(right);
    expect(onAdjustStart).toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
