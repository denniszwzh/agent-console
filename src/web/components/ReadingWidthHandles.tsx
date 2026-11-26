import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { rootRemPx, widthFromDrag, type ReadingWidth } from '../reading-width.js';

/** Width of each handle, in pixels. */
export const HANDLE_PX = 6;

interface Props {
  /** The scrolling conversation; the handles sit over its edges, outside it. */
  streamRef: RefObject<HTMLDivElement | null>;
  width: ReadingWidth;
  /** Called once when a drag or double-click starts, before the width changes. */
  onAdjustStart(): void;
  onChange(width: ReadingWidth): void;
}

const TITLE = 'Drag to change the reading width. Double-click for full width. Alt+[ / Alt+] / Alt+0';

/**
 * Handles on both edges of the reading column. Dragging either one moves both edges. While dragging,
 * the width is set on the stream directly (once per frame) and saved only when the pointer is released.
 */
export function ReadingWidthHandles({ streamRef, width, onAdjustStart, onChange }: Props) {
  const [available, setAvailable] = useState(0);
  const [drag, setDrag] = useState<number | null>(null);
  const dragRef = useRef<number | null>(null);
  const pointer = useRef<number | null>(null);
  const frame = useRef<number | null>(null);
  const pending = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    setAvailable(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setAvailable(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [streamRef]);

  // A drag cut short by unmounting must not leave the page unselectable.
  useEffect(() => () => document.body.classList.remove('reading-resizing'), []);

  const rem = rootRemPx();
  const shown = drag ?? width;
  const column = shown === null ? available : Math.min(available, shown * rem);
  const left = Math.round((available - column) / 2);
  const right = left + Math.round(column) - HANDLE_PX;

  const apply = () => {
    frame.current = null;
    const w = pending.current;
    const el = streamRef.current;
    if (w === null || !el) return;
    el.style.setProperty('--reading-max', `${w}rem`);
    dragRef.current = w;
    setDrag(w);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || pointer.current !== null) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointer.current = e.pointerId;
    document.body.classList.add('reading-resizing');
    onAdjustStart();
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = streamRef.current;
    if (e.pointerId !== pointer.current || !el) return;
    const box = el.getBoundingClientRect();
    const centre = box.left + el.clientWidth / 2;
    pending.current = widthFromDrag(e.clientX - centre, rootRemPx(), el.clientWidth / rootRemPx());
    if (frame.current === null) frame.current = requestAnimationFrame(apply);
  };

  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerId !== pointer.current) return;
    pointer.current = null;
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      apply();
    }
    pending.current = null;
    document.body.classList.remove('reading-resizing');
    const w = dragRef.current;
    dragRef.current = null;
    // The new width reaches the frame in the same render that clears the stream's own value.
    if (w !== null) onChange(w);
    streamRef.current?.style.removeProperty('--reading-max');
    setDrag(null);
  };

  const onDoubleClick = () => {
    onAdjustStart();
    onChange(null);
  };

  const label = drag === null ? null : drag * rem >= available ? 'Full width' : `${drag} rem`;

  return (
    <>
      {[left, right].map((x, i) => (
        <div
          key={i}
          role="separator"
          aria-orientation="vertical"
          aria-label="Reading width"
          title={TITLE}
          className={`reading-handle${drag !== null ? ' active' : ''}`}
          style={{ left: `${x}px` }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onDoubleClick={onDoubleClick}
        />
      ))}
      {label && (
        <div className="reading-label" style={{ left: `${right}px` }} aria-live="polite">
          {label}
        </div>
      )}
    </>
  );
}
