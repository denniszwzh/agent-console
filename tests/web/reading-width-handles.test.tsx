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

  it('a small jitter while clicking changes nothing', () => {
    const { right, onChange } = setup(null);
    fireEvent.pointerDown(right, { button: 0, pointerId: 1, pointerType: 'mouse', clientX: 997 });
    fireEvent.pointerMove(right, { pointerId: 1, clientX: 995 });
    fireEvent.pointerUp(right, { pointerId: 1 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('dragging to the edge keeps full width, and keeps a stored width wider than the window', () => {
    const full = setup(null);
    fireEvent.pointerDown(full.right, { button: 0, pointerId: 1, pointerType: 'mouse', clientX: 997 });
    fireEvent.pointerMove(full.right, { pointerId: 1, clientX: 1100 });
    fireEvent.pointerUp(full.right, { pointerId: 1 });
    expect(full.onChange).not.toHaveBeenCalled();
    cleanup();
    const wide = setup(90);
    fireEvent.pointerDown(wide.right, { button: 0, pointerId: 1, pointerType: 'mouse', clientX: 997 });
    fireEvent.pointerMove(wide.right, { pointerId: 1, clientX: 1100 });
    fireEvent.pointerUp(wide.right, { pointerId: 1 });
    expect(wide.onChange).not.toHaveBeenCalled();
  });

  it('losing the pointer capture ends the drag', () => {
    const { stream, right, onChange } = setup(null);
    fireEvent.pointerDown(right, { button: 0, pointerId: 1, pointerType: 'mouse', clientX: 1000 });
    fireEvent.pointerMove(right, { pointerId: 1, clientX: 900 });
    fireEvent.lostPointerCapture(right, { pointerId: 1 });
    expect(onChange).toHaveBeenCalledWith(50);
    expect(document.body.classList.contains('reading-resizing')).toBe(false);
    fireEvent.pointerMove(right, { pointerId: 1, clientX: 800 });
    expect(stream.style.getPropertyValue('--reading-max')).toBe('');
  });
});
