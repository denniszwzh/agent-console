import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { svgDataUrl } from '../svg.js';

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 5;
export const ZOOM_STEP = 1.25;
/** Fit never enlarges a diagram past this (small diagrams in the full-screen view). */
const MAX_FIT = 2;
/** Margin around the fitted diagram, and how much of it always stays inside the frame when panned. */
const PAD = 16;
const KEEP = 48;
const KEY_PAN = 48;
const MIN_FRAME_H = 120;
/** Used when the SVG states no size (Mermaid always does). */
const FALLBACK_WIDTH = 600;
const FALLBACK_RATIO = 0.6;
/** Wheel zoom: factor = exp(-deltaPx * WHEEL_K), with |deltaPx| capped (trackpad pinches send many small deltas). */
const WHEEL_K = 0.0025;
const WHEEL_MAX_DELTA = 100;

export interface DiagramSize {
  width: number;
  height: number;
}

/**
 * Natural size of a Mermaid SVG, read from its root tag only (labels carry their own max-width):
 * the inline `max-width` (Mermaid's own sizing) for the width, the viewBox for the aspect ratio.
 */
export function diagramSize(svg: string): DiagramSize | undefined {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? '';
  const vb = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/.exec(root);
  const maxWidth = /max-width:\s*([\d.]+)px/.exec(root);
  const vbW = vb ? Number(vb[1]) : 0;
  const vbH = vb ? Number(vb[2]) : 0;
  const width = maxWidth ? Number(maxWidth[1]) : vbW;
  if (!width) return undefined;
  return { width, height: vbW && vbH ? (width * vbH) / vbW : 0 };
}

/** Zoom factor for one ctrl/cmd + wheel event. */
export function wheelFactor(e: Pick<WheelEvent, 'deltaY' | 'deltaMode'>): number {
  const px = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
  return Math.exp(-Math.max(-WHEEL_MAX_DELTA, Math.min(WHEEL_MAX_DELTA, px)) * WHEEL_K);
}

interface FrameProps {
  url: string;
  alt: string;
  size?: DiagramSize;
  /** 'width': fit the frame's width (inline); 'contain': fit width and height (full screen). */
  fit: 'width' | 'contain';
  className: string;
  /** Extra toolbar buttons, after the zoom controls. */
  actions: ReactNode;
}

interface View {
  /** null = fit to the frame. */
  zoom: number | null;
  /** Offset from the centred position, in pixels. */
  x: number;
  y: number;
}
const FIT: View = { zoom: null, x: 0, y: 0 };

/**
 * The diagram in a fixed frame that can be panned freely in any direction, at any zoom. Zoom
 * changes the image's layout size (not a CSS scale), so the SVG is redrawn sharp at every size;
 * the position is a translate, which does not blur.
 * - Drag (mouse, pen, one finger) pans; two fingers pinch-zoom; double-click fits.
 * - Ctrl/Cmd + wheel (or a trackpad pinch) zooms around the pointer. A plain wheel or two-finger
 *   swipe pans once zoomed in (and always in full screen); at fit it scrolls the page.
 * - With the frame focused, the arrow keys pan and + / - / 0 zoom in, out and back to fit.
 * Inline, the frame is as tall as the fitted diagram; touch keeps vertical swipes for the page there.
 * All updates are functional, so several events within one frame (a trackpad pinch) compound.
 */
function ZoomFrame({ url, alt, size, fit, className, actions }: FrameProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>(FIT);
  const [panning, setPanning] = useState(false);
  // Active pointers (frame-relative positions), for drag and pinch.
  const pointers = useRef(new Map<number, { x: number; y: number }>());

  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const measure = () => setFrame({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const natW = size?.width || FALLBACK_WIDTH;
  const natH = size?.height || natW * FALLBACK_RATIO;
  const fitScale = useMemo(() => {
    if (!frame.w) return 1;
    const byWidth = Math.max(0, frame.w - 2 * PAD) / natW;
    if (fit === 'width') return Math.min(1, byWidth);
    const byHeight = frame.h ? Math.max(0, frame.h - 2 * PAD) / natH : byWidth;
    return Math.min(MAX_FIT, byWidth, byHeight);
  }, [natW, natH, frame.w, frame.h, fit]);
  // Inline, the frame keeps the fitted height whatever the zoom (the diagram is panned inside it).
  const frameHeight = fit === 'width' ? Math.max(MIN_FRAME_H, Math.round(natH * fitScale + 2 * PAD)) : undefined;
  const fw = frame.w;
  const fh = frameHeight ?? frame.h;

  /** Geometry of a view: its scale, its clamped offset and the image's box in the frame. */
  const layout = useCallback(
    (v: View) => {
      const scale = v.zoom ?? fitScale;
      const w = natW * scale;
      const h = natH * scale;
      const cx = (fw - w) / 2;
      const cy = (fh - h) / 2;
      // At least KEEP pixels of the diagram stay inside the frame on each axis.
      const left = Math.min(fw - KEEP, Math.max(KEEP - w, cx + v.x));
      const top = Math.min(fh - KEEP, Math.max(KEEP - h, cy + v.y));
      return { scale, w, h, left, top, x: left - cx, y: top - cy };
    },
    [fitScale, natW, natH, fw, fh],
  );
  // Zoom never goes below the fitted size of a very wide diagram's fit, nor above MAX_ZOOM.
  const minZoom = Math.min(MIN_ZOOM, fitScale);

  const zoomBy = useCallback(
    (factor: number, at?: { x: number; y: number }) =>
      setView((prev) => {
        const g = layout(prev);
        const z = Math.min(MAX_ZOOM, Math.max(minZoom, g.scale * factor));
        if (z === g.scale) return prev;
        // Keep the diagram point under the pointer (or the frame centre) where it is; a pointer
        // outside the diagram anchors on its nearest edge.
        const ax = at?.x ?? fw / 2;
        const ay = at?.y ?? fh / 2;
        const u = g.w ? Math.min(1, Math.max(0, (ax - g.left) / g.w)) : 0.5;
        const v = g.h ? Math.min(1, Math.max(0, (ay - g.top) / g.h)) : 0.5;
        const w = natW * z;
        const h = natH * z;
        const next = layout({ zoom: z, x: ax - u * w - (fw - w) / 2, y: ay - v * h - (fh - h) / 2 });
        return { zoom: z, x: next.x, y: next.y };
      }),
    [layout, minZoom, fw, fh, natW, natH],
  );
  const panBy = useCallback(
    (dx: number, dy: number) =>
      setView((prev) => {
        const g = layout(prev);
        const next = layout({ ...prev, x: g.x + dx, y: g.y + dy });
        return { ...prev, x: next.x, y: next.y };
      }),
    [layout],
  );
  const fitToFrame = useCallback(() => setView(FIT), []);

  const g = layout(view);
  const zoomed = view.zoom !== null;

  // The native wheel listener reads the latest handlers and state through this ref.
  const live = useRef({ zoomBy, panBy, wheelPans: false });
  useLayoutEffect(() => {
    live.current = { zoomBy, panBy, wheelPans: zoomed || fit === 'contain' };
  });
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    // Registered by hand: React's wheel listener is passive and could not stop the page zoom.
    const onWheel = (e: WheelEvent) => {
      const { zoomBy: zb, panBy: pb, wheelPans } = live.current;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        if (!e.deltaY) return;
        const r = el.getBoundingClientRect();
        zb(wheelFactor(e), { x: e.clientX - r.left, y: e.clientY - r.top });
      } else if (wheelPans) {
        e.preventDefault();
        // Shift + wheel scrolls sideways, as it does on a page.
        const dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * unit;
        const dy = (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * unit;
        pb(-dx, -dy);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = frameRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = frameRef.current;
    if (!el || (e.pointerType !== 'touch' && e.button !== 0)) return;
    e.preventDefault();
    el.focus({ preventScroll: true });
    pointers.current.set(e.pointerId, local(e));
    el.setPointerCapture?.(e.pointerId);
    setPanning(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const ps = pointers.current;
    const prev = ps.get(e.pointerId);
    if (!prev) return;
    const cur = local(e);
    if (ps.size >= 2) {
      // Pinch: zoom by the change in finger distance around their midpoint, and follow the midpoint.
      const other = [...ps.entries()].find(([id]) => id !== e.pointerId)![1];
      const before = Math.hypot(prev.x - other.x, prev.y - other.y);
      const after = Math.hypot(cur.x - other.x, cur.y - other.y);
      const mid = { x: (cur.x + other.x) / 2, y: (cur.y + other.y) / 2 };
      panBy((cur.x - prev.x) / 2, (cur.y - prev.y) / 2);
      if (before > 0 && after > 0) zoomBy(after / before, mid);
    } else {
      // Moves are applied as deltas, so a zoom or key press during a drag is not undone.
      panBy(cur.x - prev.x, cur.y - prev.y);
    }
    ps.set(e.pointerId, cur);
  };
  const endPointer = (e: ReactPointerEvent<HTMLDivElement>) => {
    const ps = pointers.current;
    if (!ps.delete(e.pointerId)) return;
    if (ps.size === 0) setPanning(false);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '+' || e.key === '=') zoomBy(ZOOM_STEP);
    else if (e.key === '-' || e.key === '_') zoomBy(1 / ZOOM_STEP);
    else if (e.key === '0') fitToFrame();
    else if (e.key === 'ArrowLeft') panBy(KEY_PAN, 0);
    else if (e.key === 'ArrowRight') panBy(-KEY_PAN, 0);
    else if (e.key === 'ArrowUp') panBy(0, KEY_PAN);
    else if (e.key === 'ArrowDown') panBy(0, -KEY_PAN);
    else return;
    e.preventDefault();
  };

  const percent = `${Math.round(g.scale * 100)}%`;

  return (
    <div className={className}>
      <div className="diagram-toolbar" role="group" aria-label="圖表工具">
        <button type="button" className="diagram-btn" aria-label="縮小" title="縮小（-、Ctrl + 滾輪）" onClick={() => zoomBy(1 / ZOOM_STEP)}>
          −
        </button>
        <button
          type="button"
          className="diagram-btn diagram-zoom"
          aria-label={`${percent}，符合大小`}
          title="符合大小（0、按兩下圖表）"
          onClick={fitToFrame}
        >
          {percent}
        </button>
        <button type="button" className="diagram-btn" aria-label="放大" title="放大（+、Ctrl + 滾輪）" onClick={() => zoomBy(ZOOM_STEP)}>
          ＋
        </button>
        {actions}
      </div>
      <div
        ref={frameRef}
        className={`diagram-frame${zoomed ? ' zoomed' : ''}${panning ? ' panning' : ''}`}
        style={frameHeight ? { height: `${frameHeight}px` } : undefined}
        role="group"
        aria-roledescription="可移動的圖表"
        aria-label="拖曳或用方向鍵移動，+ / - 縮放，0 符合大小"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onLostPointerCapture={endPointer}
        onDoubleClick={fitToFrame}
        onKeyDown={onKeyDown}
      >
        {/* Rendered through <img>: the SVG cannot run scripts or touch the page. */}
        <img
          src={url}
          alt={alt}
          draggable={false}
          style={{
            width: `${Math.round(g.w)}px`,
            height: `${Math.round(g.h)}px`,
            transform: `translate(${Math.round(g.left)}px, ${Math.round(g.top)}px)`,
          }}
        />
      </div>
    </div>
  );
}


/** Saves the SVG through a Blob URL (data URLs over ~2 MB are refused by Chrome). */
function downloadSvg(svg: string): void {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'diagram.svg';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function DownloadButton({ svg }: { svg: string }) {
  return (
    <button type="button" className="diagram-btn" aria-label="下載 SVG" title="下載 SVG" onClick={() => downloadSvg(svg)}>
      ⤓
    </button>
  );
}

function FullScreen({ svg, url, size, onClose }: { svg: string; url: string; size?: DiagramSize; onClose(): void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const pressedOnBackdrop = useRef(false);
  useEffect(() => {
    closeRef.current?.focus();
    // The page behind is inert while the view is open: no focus, no clicks, no Esc for its own fields.
    const root = document.getElementById('root');
    const wasInert = root?.hasAttribute('inert') ?? true;
    if (root && !wasInert) root.setAttribute('inert', '');
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (root && !wasInert) root.removeAttribute('inert');
    };
  }, [onClose]);

  // Only a press that starts and ends on the backdrop closes (not a drag that ends there).
  const onBackdropDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    pressedOnBackdrop.current = e.target === e.currentTarget;
  };
  const onBackdropClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && pressedOnBackdrop.current) onClose();
    pressedOnBackdrop.current = false;
  };

  return createPortal(
    <div
      className="diagram-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Mermaid 圖表（全螢幕）"
      onPointerDown={onBackdropDown}
      onClick={onBackdropClick}
    >
      <ZoomFrame
        url={url}
        alt="Mermaid 圖表"
        size={size}
        fit="contain"
        className="diagram diagram-full"
        actions={
          <>
            <DownloadButton svg={svg} />
            <button ref={closeRef} type="button" className="diagram-btn" aria-label="關閉全螢幕" title="關閉（Esc）" onClick={onClose}>
              ✕
            </button>
          </>
        }
      />
    </div>,
    document.body,
  );
}

/** Mermaid diagram with zoom, pan, a full-screen view, its source and an SVG download. */
export function DiagramViewer({ svg, code }: { svg: string; code: string }) {
  const url = useMemo(() => svgDataUrl(svg), [svg]);
  const size = useMemo(() => diagramSize(svg), [svg]);
  const [showSource, setShowSource] = useState(false);
  const [full, setFull] = useState(false);
  const fullRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setFull(false), []);
  // Focus goes back to the button that opened the view (a click does not focus a button everywhere).
  // Run as an effect: by then the overlay's cleanup has made the page behind it interactive again.
  const wasFull = useRef(false);
  useEffect(() => {
    if (wasFull.current && !full) fullRef.current?.focus();
    wasFull.current = full;
  }, [full]);

  const sourceToggle = (
    <button
      type="button"
      className="diagram-btn"
      aria-pressed={showSource}
      aria-label="顯示原始碼"
      title={showSource ? '顯示圖表' : '顯示原始碼'}
      onClick={() => setShowSource((v) => !v)}
    >
      {'</>'}
    </button>
  );

  return (
    <figure className="mermaid">
      {showSource ? (
        <div className="diagram">
          <div className="diagram-toolbar" role="group" aria-label="圖表工具">
            {sourceToggle}
          </div>
          <pre className="diagram-source">
            <code>{code}</code>
          </pre>
        </div>
      ) : (
        <ZoomFrame
          url={url}
          alt="Mermaid 圖表"
          size={size}
          fit="width"
          className="diagram"
          actions={
            <>
              {sourceToggle}
              <DownloadButton svg={svg} />
              <button ref={fullRef} type="button" className="diagram-btn" aria-label="全螢幕" title="全螢幕" onClick={() => setFull(true)}>
                ⛶
              </button>
            </>
          }
        />
      )}
      {full && <FullScreen svg={svg} url={url} size={size} onClose={close} />}
    </figure>
  );
}
