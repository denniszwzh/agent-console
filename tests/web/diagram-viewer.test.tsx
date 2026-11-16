// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DiagramViewer, diagramSize, wheelFactor } from '../../src/web/components/DiagramViewer.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.getElementById('root')?.remove();
});

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" style="max-width: 400px;"><rect width="10" height="10"/></svg>';
const CODE = 'flowchart TB\n  A --> B';
const img = () => screen.getByRole('img', { name: 'Mermaid 圖表' }) as HTMLImageElement;
const frame = () => img().parentElement as HTMLDivElement;
const fitButton = () => screen.getByRole('button', { name: /符合大小/ }) as HTMLButtonElement;

/** jsdom has no layout: give the frame a size and scrollable content. */
function fakeLayout(el: HTMLElement, box: { clientWidth: number; clientHeight: number; scrollWidth: number; scrollHeight: number }) {
  for (const [k, v] of Object.entries(box)) Object.defineProperty(el, k, { configurable: true, value: v });
  el.getBoundingClientRect = () => ({ left: 0, top: 0, x: 0, y: 0, width: box.clientWidth, height: box.clientHeight, right: box.clientWidth, bottom: box.clientHeight, toJSON: () => ({}) });
}

describe('diagramSize', () => {
  it('reads the width from the root max-width and the height from the viewBox ratio', () => {
    expect(diagramSize(SVG)).toEqual({ width: 400, height: 200 });
    expect(diagramSize('<svg viewBox="0 0 300 150"></svg>')).toEqual({ width: 300, height: 150 });
    expect(diagramSize('<svg></svg>')).toBeUndefined();
  });

  it('ignores the max-width of labels inside the diagram', () => {
    const svg = '<svg viewBox="0 0 600 300"><foreignObject><div style="max-width: 200px;">x</div></foreignObject></svg>';
    expect(diagramSize(svg)).toEqual({ width: 600, height: 300 });
  });
});

describe('wheelFactor', () => {
  it('scales with the wheel distance, capped per event', () => {
    expect(wheelFactor({ deltaY: -100, deltaMode: 0 })).toBeCloseTo(Math.exp(0.25));
    expect(wheelFactor({ deltaY: -2, deltaMode: 0 })).toBeCloseTo(Math.exp(0.005));
    expect(wheelFactor({ deltaY: 5000, deltaMode: 0 })).toBeCloseTo(Math.exp(-0.25));
    expect(wheelFactor({ deltaY: -3, deltaMode: 1 })).toBeCloseTo(Math.exp(0.12));
  });
});

describe('DiagramViewer', () => {
  it('starts at its natural size, capped by the frame, and zooms with the buttons', () => {
    render(<DiagramViewer svg={SVG} code={CODE} />);
    expect(img().style.width).toBe('400px');
    expect(img().style.maxWidth).toBe('100%');
    expect(fitButton().disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '放大' }));
    expect(img().style.width).toBe('500px');
    expect(img().style.maxWidth).toBe('none');
    expect(fitButton().textContent).toBe('125%');
    expect(fitButton().getAttribute('aria-label')).toBe('125%，符合大小');

    fireEvent.click(screen.getByRole('button', { name: '縮小' }));
    fireEvent.click(screen.getByRole('button', { name: '縮小' }));
    expect(img().style.width).toBe('320px');

    fireEvent.click(fitButton());
    expect(img().style.width).toBe('400px');
    expect(img().style.maxWidth).toBe('100%');
  });

  it('keeps zoom within its bounds', () => {
    render(<DiagramViewer svg={SVG} code={CODE} />);
    for (let i = 0; i < 30; i++) fireEvent.click(screen.getByRole('button', { name: '放大' }));
    expect(img().style.width).toBe('2000px');
    for (let i = 0; i < 40; i++) fireEvent.click(screen.getByRole('button', { name: '縮小' }));
    expect(img().style.width).toBe('40px');
  });

  it('fits a diagram wider than the frame to the frame width', () => {
    const ro = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = ro;
        disconnect() {}
      },
    );
    // Shadows Element.prototype.clientWidth for the duration of the test only.
    const proto = HTMLElement.prototype;
    Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => 200 });
    try {
      render(<DiagramViewer svg={SVG} code={CODE} />);
      expect(img().style.width).toBe('200px');
      expect(fitButton().textContent).toBe('50%');
      expect(ro).toHaveBeenCalled();
    } finally {
      delete (proto as unknown as Record<string, unknown>).clientWidth;
      vi.unstubAllGlobals();
    }
  });

  it('zooms with Ctrl + wheel by the wheel distance and leaves a plain wheel to the page', () => {
    render(<DiagramViewer svg={SVG} code={CODE} />);
    const plain = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    frame().dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
    expect(img().style.width).toBe('400px');

    const step = new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true });
    fireEvent(frame(), step);
    expect(step.defaultPrevented).toBe(true);
    expect(img().style.width).toBe(`${Math.round(400 * Math.exp(0.25))}px`);

    // Small pinch deltas make small steps; a sideways-only event does not zoom.
    fireEvent(frame(), new WheelEvent('wheel', { deltaY: 4, ctrlKey: true, bubbles: true, cancelable: true }));
    expect(img().style.width).toBe(`${Math.round(400 * Math.exp(0.25) * Math.exp(-0.01))}px`);
    const before = img().style.width;
    fireEvent(frame(), new WheelEvent('wheel', { deltaX: 50, ctrlKey: true, bubbles: true, cancelable: true }));
    expect(img().style.width).toBe(before);
  });

  it('zooms with + / - / 0 when the diagram has focus', () => {
    render(<DiagramViewer svg={SVG} code={CODE} />);
    expect(frame().tabIndex).toBe(0);
    fireEvent.keyDown(frame(), { key: '+' });
    expect(img().style.width).toBe('500px');
    fireEvent.keyDown(frame(), { key: '-' });
    fireEvent.keyDown(frame(), { key: '-' });
    expect(img().style.width).toBe('320px');
    fireEvent.keyDown(frame(), { key: '0' });
    expect(img().style.width).toBe('400px');
    fireEvent.keyDown(frame(), { key: '+', ctrlKey: true });
    expect(img().style.width).toBe('400px');
  });

  it('pans by dragging with a mouse, but not from the scrollbar, with touch, or when nothing overflows', () => {
    render(<DiagramViewer svg={SVG} code={CODE} />);
    const f = frame();
    fakeLayout(f, { clientWidth: 300, clientHeight: 200, scrollWidth: 300, scrollHeight: 200 });
    fireEvent.pointerDown(f, { button: 0, pointerId: 1, pointerType: 'mouse', clientX: 100, clientY: 100 });
    expect(f.className).not.toContain('panning');

    fakeLayout(f, { clientWidth: 300, clientHeight: 200, scrollWidth: 900, scrollHeight: 600 });
    f.scrollLeft = 100;
    f.scrollTop = 50;
    fireEvent.pointerDown(f, { button: 0, pointerId: 2, pointerType: 'touch', clientX: 100, clientY: 100 });
    expect(f.className).not.toContain('panning');
    // A press on the vertical scrollbar (right of the client area).
    fireEvent.pointerDown(f, { button: 0, pointerId: 3, pointerType: 'mouse', clientX: 305, clientY: 100 });
    expect(f.className).not.toContain('panning');

    fireEvent.pointerDown(f, { button: 0, pointerId: 4, pointerType: 'mouse', clientX: 100, clientY: 100 });
    expect(f.className).toContain('panning');
    fireEvent.pointerMove(f, { pointerId: 4, clientX: 60, clientY: 80 });
    expect([f.scrollLeft, f.scrollTop]).toEqual([140, 70]);
    fireEvent.pointerUp(f, { pointerId: 4 });
    expect(f.className).not.toContain('panning');
    fireEvent.pointerMove(f, { pointerId: 4, clientX: 0, clientY: 0 });
    expect([f.scrollLeft, f.scrollTop]).toEqual([140, 70]);
  });

  it('a zoom press at the limit does not move the view later when fitting', () => {
    render(<DiagramViewer svg={SVG} code={CODE} />);
    for (let i = 0; i < 30; i++) fireEvent.click(screen.getByRole('button', { name: '放大' }));
    const f = frame();
    fakeLayout(f, { clientWidth: 300, clientHeight: 200, scrollWidth: 2000, scrollHeight: 1000 });
    Object.defineProperty(img(), 'clientWidth', { configurable: true, value: 2000 });
    Object.defineProperty(img(), 'clientHeight', { configurable: true, value: 1000 });
    f.scrollLeft = 10;
    f.scrollTop = 20;
    fireEvent.click(screen.getByRole('button', { name: '放大' })); // already at 500%
    fireEvent.click(fitButton());
    expect([f.scrollLeft, f.scrollTop]).toEqual([10, 20]);
  });

  it('shows the source instead of the diagram and back', () => {
    render(<DiagramViewer svg={SVG} code={CODE} />);
    fireEvent.click(screen.getByRole('button', { name: '顯示原始碼' }));
    expect(screen.getByText(/flowchart TB/)).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '顯示原始碼' }));
    expect(img()).toBeTruthy();
  });

  it('downloads the SVG through a Blob URL', async () => {
    const create = vi.fn(() => 'blob:x');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const clicks: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this);
    });
    render(<DiagramViewer svg={SVG} code={CODE} />);
    fireEvent.click(screen.getByRole('button', { name: '下載 SVG' }));
    expect(create).toHaveBeenCalledTimes(1);
    const blob = (create.mock.calls[0] as unknown as [Blob])[0];
    expect(blob.type).toBe('image/svg+xml');
    expect(await blob.text()).toBe(SVG);
    expect(clicks.map((a) => [a.getAttribute('href'), a.download])).toEqual([['blob:x', 'diagram.svg']]);
    await new Promise((r) => setTimeout(r, 0));
    expect(revoke).toHaveBeenCalledWith('blob:x');
  });

  it('opens a full-screen view that makes the page inert; Esc, the close button or a backdrop click closes it', async () => {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);
    render(<DiagramViewer svg={SVG} code={CODE} />, { container: root });
    const open = screen.getByRole('button', { name: '全螢幕' });
    fireEvent.click(open);
    expect(screen.getByRole('dialog', { name: 'Mermaid 圖表（全螢幕）' })).toBeTruthy();
    expect(root.hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '關閉全螢幕' }));

    const pageKeys = vi.fn();
    window.addEventListener('keydown', pageKeys);
    fireEvent.keyDown(document, { key: 'Escape' });
    window.removeEventListener('keydown', pageKeys);
    expect(pageKeys).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(root.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(open);

    fireEvent.click(open);
    fireEvent.click(screen.getByRole('button', { name: '關閉全螢幕' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(open);

    fireEvent.click(open);
    const overlay = screen.getByRole('dialog');
    // A drag that starts inside the view and ends on the backdrop does not close it.
    fireEvent.pointerDown(overlay.querySelector('img')!);
    fireEvent.click(overlay);
    expect(screen.queryByRole('dialog')).toBeTruthy();
    fireEvent.pointerDown(overlay);
    fireEvent.click(overlay);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('cleans up when it unmounts while full screen', () => {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);
    const { unmount } = render(<DiagramViewer svg={SVG} code={CODE} />, { container: root });
    fireEvent.click(screen.getByRole('button', { name: '全螢幕' }));
    unmount();
    expect(root.hasAttribute('inert')).toBe(false);
    expect(document.querySelector('.diagram-overlay')).toBeNull();
  });
});
