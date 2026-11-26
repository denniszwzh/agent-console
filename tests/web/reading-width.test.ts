// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  READING_WIDTH_KEY,
  narrower,
  parseReadingWidths,
  readingWidthStyle,
  useReadingWidth,
  wider,
  widthFromDrag,
  widthShortcut,
} from '../../src/web/reading-width.js';

beforeEach(() => localStorage.clear());

describe('reading width logic', () => {
  it('parses stored widths and falls back to full width', () => {
    expect(parseReadingWidths(null)).toEqual({ wide: null, compact: null });
    expect(parseReadingWidths('not json')).toEqual({ wide: null, compact: null });
    expect(parseReadingWidths('{"wide":52,"compact":"x"}')).toEqual({ wide: 52, compact: null });
    expect(parseReadingWidths('{"wide":10}')).toEqual({ wide: 24, compact: null });
  });

  it('narrows from the smaller of the stored and the visible width', () => {
    expect(narrower(null, 80)).toBe(76);
    expect(narrower(60, 80)).toBe(56);
    expect(narrower(60, 50)).toBe(46);
    expect(narrower(26, 80)).toBe(24);
  });

  it('widens without turning a stored width into full width', () => {
    expect(wider(null, 80)).toBeNull();
    expect(wider(60, 80)).toBe(64);
    expect(wider(78, 80)).toBe(80);
    expect(wider(90, 80)).toBe(90);
  });

  it('turns a drag distance from the centre into a width', () => {
    expect(widthFromDrag(400, 16, 100)).toBe(50);
    expect(widthFromDrag(-400, 16, 100)).toBe(50);
    expect(widthFromDrag(100, 16, 100)).toBe(24);
    expect(widthFromDrag(2000, 16, 100)).toBe(100);
    // At the edge the visible width is returned unrounded, so callers can tell it from a set width.
    expect(widthFromDrag(2000, 16, 62.6875)).toBe(62.6875);
    expect(widthFromDrag(2000, 16, 20)).toBe(24);
  });

  it('recognises the shortcuts by physical key, not with Ctrl (AltGr) or in text fields', () => {
    const base = { altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, target: document.body, key: 'x' };
    expect(widthShortcut({ ...base, code: 'BracketLeft' })).toBe('narrower');
    expect(widthShortcut({ ...base, code: 'BracketRight' })).toBe('wider');
    expect(widthShortcut({ ...base, code: 'Digit0' })).toBe('full');
    expect(widthShortcut({ ...base, code: 'Numpad0' })).toBeNull();
    expect(widthShortcut({ ...base, ctrlKey: true, code: 'BracketLeft' })).toBeNull();
    expect(widthShortcut({ ...base, altKey: false, code: 'BracketLeft' })).toBeNull();
    expect(widthShortcut({ ...base, code: 'BracketLeft', target: document.createElement('textarea') })).toBeNull();
  });

  it('falls back to the typed key when the event has no physical key code', () => {
    const base = { altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, target: document.body, code: '' };
    expect(widthShortcut({ ...base, key: '[' })).toBe('narrower');
    expect(widthShortcut({ ...base, key: ']' })).toBe('wider');
    expect(widthShortcut({ ...base, key: '0' })).toBe('full');
    expect(widthShortcut({ ...base, key: '[', code: 'Digit8' })).toBeNull();
  });

  it('exposes the width as a CSS variable', () => {
    expect(readingWidthStyle(null)).toBeUndefined();
    expect(readingWidthStyle(52)).toEqual({ '--reading-max': '52rem' });
  });
});

describe('useReadingWidth', () => {
  it('keeps separate widths for the wide and compact layouts', () => {
    const wide = renderHook(() => useReadingWidth(false));
    act(() => wide.result.current.setWidth(52));
    const compact = renderHook(() => useReadingWidth(true));
    expect(compact.result.current.width).toBeNull();
    act(() => compact.result.current.setWidth(40));
    expect(JSON.parse(localStorage.getItem(READING_WIDTH_KEY)!)).toEqual({ wide: 52, compact: 40 });
  });

  it('follows changes made in another window', () => {
    const { result } = renderHook(() => useReadingWidth(false));
    localStorage.setItem(READING_WIDTH_KEY, '{"wide":44,"compact":null}');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: READING_WIDTH_KEY }));
    });
    expect(result.current.width).toBe(44);
  });
});
