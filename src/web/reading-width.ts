import { useCallback, useEffect, useState, type CSSProperties } from 'react';

/**
 * The conversation's reading column has a maximum width, like a reading mode: long lines on a wide
 * screen are tiring to read.
 *
 * The width is stored as an absolute value (rem), never as a share of the screen, so a narrower screen
 * shows the text at full width instead of squeezing it by the same ratio. The wide layout and the
 * compact one (portrait / narrow, see COMPACT_QUERY) keep separate values, so tuning one never changes
 * the other.
 */
export const READING_WIDTH_KEY = 'agent-console.readingWidth';
export const MIN_READING_REM = 24;
export const READING_STEP_REM = 4;

/** rem; null = full width. */
export type ReadingWidth = number | null;

export interface ReadingWidths {
  wide: ReadingWidth;
  compact: ReadingWidth;
}

export type WidthShortcut = 'narrower' | 'wider' | 'full';

const FULL: ReadingWidths = { wide: null, compact: null };

/** Rounded to half a rem and never below the minimum. */
function tidy(rem: number): number {
  return Math.max(MIN_READING_REM, Math.round(rem * 2) / 2);
}

function parseOne(v: unknown): ReadingWidth {
  return typeof v === 'number' && Number.isFinite(v) ? tidy(v) : null;
}

export function parseReadingWidths(text: string | null): ReadingWidths {
  try {
    const raw = JSON.parse(text ?? 'null') as { wide?: unknown; compact?: unknown } | null;
    if (!raw || typeof raw !== 'object') return FULL;
    return { wide: parseOne(raw.wide), compact: parseOne(raw.compact) };
  } catch {
    return FULL;
  }
}

/** One step narrower, starting from what is on screen (a stored width can be wider than the window). */
export function narrower(stored: ReadingWidth, availableRem: number): number {
  const from = stored === null ? availableRem : Math.min(stored, availableRem);
  return tidy(from - READING_STEP_REM);
}

/**
 * One step wider. A width already at or past the visible width is kept as it is: widening in a small
 * window must not overwrite a width tuned on a bigger one. Only Alt+0 or a double-click stores full width.
 */
export function wider(stored: ReadingWidth, availableRem: number): ReadingWidth {
  if (stored === null || stored >= availableRem) return stored;
  return tidy(Math.min(stored + READING_STEP_REM, availableRem));
}

/** The column width for a pointer `distancePx` from the column's centre (both edges move together). */
export function widthFromDrag(distancePx: number, remPx: number, availableRem: number): number {
  const rem = (2 * Math.abs(distancePx)) / remPx;
  return tidy(Math.min(rem, Math.max(MIN_READING_REM, availableRem)));
}

function isTextField(target: EventTarget | null): boolean {
  if (!target || typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable;
}

/**
 * Alt+[ / Alt+] / Alt+0, by physical key so other layouts work. Ctrl must be up: Windows reports AltGr as
 * Ctrl+Alt, and AltGr+8 types "[" on a German keyboard. Text fields keep their keys (Option+[ types a
 * character on macOS). Events without a physical key code (some remote-desktop and on-screen keyboards)
 * fall back to the typed character.
 */
export function widthShortcut(e: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'code' | 'key' | 'target'>): WidthShortcut | null {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || isTextField(e.target)) return null;
  const key = e.code === '' ? e.key : e.code;
  if (key === 'BracketLeft' || key === '[') return 'narrower';
  if (key === 'BracketRight' || key === ']') return 'wider';
  if (key === 'Digit0' || key === '0') return 'full';
  return null;
}

export function readingWidthStyle(width: ReadingWidth): CSSProperties | undefined {
  return width === null ? undefined : ({ '--reading-max': `${width}rem` } as CSSProperties);
}

/** Pixels per rem. */
export function rootRemPx(): number {
  if (typeof document === 'undefined') return 16;
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

function readWidths(): ReadingWidths {
  try {
    return parseReadingWidths(localStorage.getItem(READING_WIDTH_KEY));
  } catch {
    return FULL;
  }
}

function writeWidths(widths: ReadingWidths): void {
  try {
    localStorage.setItem(READING_WIDTH_KEY, JSON.stringify(widths));
  } catch {
    // Storage unavailable: the width just is not remembered.
  }
}

/** The reading width for the current layout, remembered per browser and shared by its windows. */
export function useReadingWidth(compact: boolean): { width: ReadingWidth; setWidth(w: ReadingWidth): void } {
  const [widths, setWidths] = useState(readWidths);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === READING_WIDTH_KEY || e.key === null) setWidths(readWidths());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setWidth = useCallback(
    (w: ReadingWidth) => {
      // Re-read first, so a value another window saved for the other layout is kept.
      const next = { ...readWidths(), [compact ? 'compact' : 'wide']: w === null ? null : tidy(w) };
      writeWidths(next);
      setWidths(next);
    },
    [compact],
  );

  return { width: compact ? widths.compact : widths.wide, setWidth };
}
