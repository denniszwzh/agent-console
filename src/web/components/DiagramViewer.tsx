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

const clamp = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

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

/**
 * A scrollable frame showing the diagram image. Zoom changes the image's layout width (not a CSS
 * transform), so the SVG is redrawn sharp at every size. Ctrl/Cmd + wheel (or a trackpad pinch)
 * zooms around the pointer; dragging with a mouse or pen pans when the diagram overflows the frame.
 * With the frame focused, + / - / 0 zoom in, out and back to fit.
 */
function ZoomFrame({ url, alt, size, fit, className, actions }: FrameProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [frame, setFrame] = useState({ w: 0, h: 0 });
  // null = fit to the frame.
  const [zoom, setZoom] = useState<number | null>(null);
  const [canPan, setCanPan] = useState(false);
  const [panning, setPanning] = useState(false);
  const anchor = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number; id: number } | null>(null);

  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    // Content box: fitting to clientWidth would overflow by the padding.
    const measure = () => {
      const cs = getComputedStyle(el);
      const px = (v: string) => Number.parseFloat(v) || 0;
      setFrame({
        w: Math.max(0, el.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight)),
        h: Math.max(0, el.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom)),
      });
    };
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const natural = size?.width ?? 0;
  const fitScale = useMemo(() => {
    if (!natural || !frame.w) return 1;
    const byWidth = frame.w / natural;
    const s = fit === 'contain' && size?.height && frame.h ? Math.min(byWidth, frame.h / size.height) : byWidth;
    return Math.min(fit === 'contain' ? MAX_FIT : 1, s);
  }, [natural, size?.height, frame.w, frame.h, fit]);
  const scale = zoom ?? fitScale;

  const zoomTo = useCallback(
    (next: number, at?: { x: number; y: number }) => {
      const z = clamp(next);
      if (z === scale) return; // at a limit: nothing changes, so nothing to anchor
      const el = frameRef.current;
      const img = imgRef.current;
      if (el && img && img.clientWidth) {
        // Remember which point of the diagram is under the pointer (or the frame centre), so it stays put.
        const x = at?.x ?? el.clientWidth / 2;
        const y = at?.y ?? el.clientHeight / 2;
        anchor.current = {
          x,
          y,
          px: (el.scrollLeft + x - img.offsetLeft) / img.clientWidth,
          py: img.clientHeight ? (el.scrollTop + y - img.offsetTop) / img.clientHeight : 0,
        };
      }
      setZoom(z);
    },
    [scale],
  );
  const fitToFrame = useCallback(() => {
    anchor.current = null;
    setZoom(null);
  }, []);

  // After the image got its new size: put the anchored point back, and see whether there is anything to pan.
  useLayoutEffect(() => {
    const el = frameRef.current;
    const img = imgRef.current;
    const a = anchor.current;
    anchor.current = null;
    if (el && img && a) {
      el.scrollLeft = img.offsetLeft + a.px * img.clientWidth - a.x;
      el.scrollTop = img.offsetTop + a.py * img.clientHeight - a.y;
    }
    if (el) setCanPan(el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight);
  }, [scale]);

  const wheel = useRef({ zoomTo, scale });
  useLayoutEffect(() => {
    wheel.current = { zoomTo, scale };
  });
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    // Registered by hand: React's wheel listener is passive and could not stop the page zoom.
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      if (!e.deltaY) return;
      const r = el.getBoundingClientRect();
      const { zoomTo: zt, scale: s } = wheel.current;
      zt(s * wheelFactor(e), { x: e.clientX - r.left, y: e.clientY - r.top });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = frameRef.current;
    // Touch keeps the browser's own scrolling; only a mouse or pen drag pans.
    if (!el || e.button !== 0 || e.pointerType === 'touch') return;
    if (el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight) return;
    // A press on the frame's own scrollbars is left to the browser.
    const r = el.getBoundingClientRect();
    if (e.clientX - r.left - el.clientLeft >= el.clientWidth || e.clientY - r.top - el.clientTop >= el.clientHeight) return;
    e.preventDefault();
    drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop, id: e.pointerId };
    el.setPointerCapture?.(e.pointerId);
    setPanning(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = frameRef.current;
    const d = drag.current;
    if (!el || !d || d.id !== e.pointerId) return;
    el.scrollLeft = d.left - (e.clientX - d.x);
    el.scrollTop = d.top - (e.clientY - d.y);
  };
  const endPan = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    setPanning(false);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '+' || e.key === '=') zoomTo(scale * ZOOM_STEP);
    else if (e.key === '-' || e.key === '_') zoomTo(scale / ZOOM_STEP);
    else if (e.key === '0') fitToFrame();
    else return;
    e.preventDefault();
  };

  const percent = `${Math.round(scale * 100)}%`;
  const imgStyle = natural
    ? { width: `${Math.round(natural * scale)}px`, maxWidth: zoom === null && fit === 'width' ? '100%' : 'none' }
    : undefined;

  return (
    <div className={className}>
      <div className="diagram-toolbar" role="group" aria-label="圖表工具">
        <button type="button" className="diagram-btn" aria-label="縮小" title="縮小（-、Ctrl + 滾輪）" onClick={() => zoomTo(scale / ZOOM_STEP)}>
          −
        </button>
        <button
          type="button"
          className="diagram-btn diagram-zoom"
          aria-label={`${percent}，符合大小`}
          title="符合大小（0）"
          onClick={fitToFrame}
          disabled={zoom === null}
        >
          {percent}
        </button>
        <button type="button" className="diagram-btn" aria-label="放大" title="放大（+、Ctrl + 滾輪）" onClick={() => zoomTo(scale * ZOOM_STEP)}>
          ＋
        </button>
        {actions}
      </div>
      <div
        ref={frameRef}
        className={`diagram-frame${canPan ? ' pannable' : ''}${panning ? ' panning' : ''}`}
        tabIndex={0}
        aria-label={`${alt}，${percent}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onKeyDown={onKeyDown}
      >
        {/* Rendered through <img>: the SVG cannot run scripts or touch the page. */}
        <img ref={imgRef} src={url} alt={alt} draggable={false} style={imgStyle} />
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
