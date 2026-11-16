// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DiagramViewer, diagramSize, wheelFactor } from '../../src/web/components/DiagramViewer.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.getElementById('root')?.remove();
});

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" style="max-width: 400px;"><rect width="10" height="10"/></svg>';
const CODE = 'flowchart TB\n  A --> B';
const img = () => screen.getByRole('img', { name: 'Mermaid diagram' }) as HTMLImageElement;
const frame = () => img().parentElement as HTMLDivElement;
const fitButton = () => screen.getByRole('button', { name: /fit to view/ }) as HTMLButtonElement;

/** jsdom has no layout: give every element this width while `fn` runs. */
function withFrameWidth(width: number, fn: () => void) {
  const proto = HTMLElement.prototype;
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => width });
  try {
    fn();
  } finally {
    // Removes the shadowing property; Element.prototype.clientWidth applies again.
    delete (proto as unknown as Record<string, unknown>).clientWidth;
  }
}
/** The image's translate, as [x, y]. */
const pos = () => {
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(img().style.transform);
  return m ? [Number(m[1]), Number(m[2])] : [];
};

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

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(img().style.width).toBe('500px');
    expect(fitButton().textContent).toBe('125%');
    expect(fitButton().getAttribute('aria-label')).toBe('125%, fit to view');

    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(img().style.width).toBe('320px');

    fireEvent.click(fitButton());
    expect(img().style.width).toBe('400px');
  });

  it('keeps zoom within its bounds', () => {
    render(<DiagramViewer svg={SVG} code={CODE} />);
    for (let i = 0; i < 30; i++) fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(img().style.width).toBe('2000px');
    for (let i = 0; i < 40; i++) fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
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
    try {
      withFrameWidth(232, () => {
        render(<DiagramViewer svg={SVG} code={CODE} />);
        // (232 - 2 × 16) / 400 = 50%
        expect(img().style.width).toBe('200px');
        expect(fitButton().textContent).toBe('50%');
        expect(ro).toHaveBeenCalled();
      });
    } finally {
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

  it('can be dragged in any direction, even when the whole diagram fits', () => {
    withFrameWidth(600, () => {
      render(<DiagramViewer svg={SVG} code={CODE} />);
      const f = frame();
      // Fit: 400×200 centred in a 600-wide frame that is as tall as the diagram plus margins.
      expect(f.style.height).toBe('232px');
      expect(pos()).toEqual([100, 16]);

      fireEvent.pointerDown(f, { button: 0, pointerId: 1, pointerType: 'mouse', clientX: 100, clientY: 100 });
      expect(f.className).toContain('panning');
      fireEvent.pointerMove(f, { pointerId: 1, clientX: 60, clientY: 130 });
      expect(pos()).toEqual([60, 46]);
      fireEvent.pointerMove(f, { pointerId: 1, clientX: 150, clientY: 60 });
      expect(pos()).toEqual([150, -24]);
      fireEvent.pointerUp(f, { pointerId: 1 });
      expect(f.className).not.toContain('panning');
      fireEvent.pointerMove(f, { pointerId: 1, clientX: 0, clientY: 0 });
      expect(pos()).toEqual([150, -24]);

      // Double-click puts it back.
      fireEvent.doubleClick(f);
      expect(pos()).toEqual([100, 16]);
    });
  });

  it('keeps part of the diagram in view however far it is dragged', () => {
    withFrameWidth(600, () => {
      render(<DiagramViewer svg={SVG} code={CODE} />);
      const f = frame();
      fireEvent.pointerDown(f, { button: 0, pointerId: 1, pointerType: 'mouse', clientX: 0, clientY: 0 });
      fireEvent.pointerMove(f, { pointerId: 1, clientX: 5000, clientY: 5000 });
      // At least 48 px stay inside the 600×232 frame.
      expect(pos()).toEqual([552, 184]);
      fireEvent.pointerMove(f, { pointerId: 1, clientX: -5000, clientY: -5000 });
      expect(pos()).toEqual([48 - 400, 48 - 200]);
    });
  });

  it('pans with touch and the arrow keys, but not with other mouse buttons', () => {
    withFrameWidth(600, () => {
      render(<DiagramViewer svg={SVG} code={CODE} />);
      const f = frame();
      fireEvent.pointerDown(f, { button: 2, pointerId: 1, pointerType: 'mouse', clientX: 0, clientY: 0 });
      expect(f.className).not.toContain('panning');

      fireEvent.pointerDown(f, { button: 0, pointerId: 2, pointerType: 'touch', clientX: 0, clientY: 0 });
      fireEvent.pointerMove(f, { pointerId: 2, clientX: -30, clientY: 10 });
      expect(pos()).toEqual([70, 26]);
      fireEvent.pointerUp(f, { pointerId: 2 });

      fireEvent.keyDown(f, { key: 'ArrowRight' });
      expect(pos()).toEqual([22, 26]);
      fireEvent.keyDown(f, { key: 'ArrowUp' });
      expect(pos()).toEqual([22, 74]);
      fireEvent.keyDown(f, { key: 'ArrowLeft' });
      fireEvent.keyDown(f, { key: 'ArrowDown' });
      expect(pos()).toEqual([70, 26]);
    });
  });

  it('zooms around the pointer and keeps the frame height', () => {
    withFrameWidth(600, () => {
      render(<DiagramViewer svg={SVG} code={CODE} />);
      const f = frame();
      // Point (300, 116) is the diagram's centre; (150, 66) is a quarter in from its top-left.
      fireEvent(f, new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, clientX: 150, clientY: 66, bubbles: true, cancelable: true }));
      const s = Math.exp(0.25);
      const [x, y] = pos();
      // The diagram point under the pointer stays under it.
      expect((150 - x) / (400 * s)).toBeCloseTo((150 - 100) / 400, 2);
      expect((66 - y) / (200 * s)).toBeCloseTo((66 - 16) / 200, 2);
      expect(f.style.height).toBe('232px');
      expect(f.className).toContain('zoomed');
    });
  });

  it('a zoom press at the limit leaves the view where it is', () => {
    withFrameWidth(600, () => {
      render(<DiagramViewer svg={SVG} code={CODE} />);
      for (let i = 0; i < 30; i++) fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
      const before = pos();
      fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
      expect(pos()).toEqual(before);
    });
  });

  it('a plain wheel pans once zoomed in (Shift for sideways) and scrolls the page at fit', () => {
    withFrameWidth(600, () => {
      render(<DiagramViewer svg={SVG} code={CODE} />);
      const f = frame();
      const atFit = new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true });
      f.dispatchEvent(atFit);
      expect(atFit.defaultPrevented).toBe(false);

      fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
      const [x0, y0] = pos();
      const down = new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true });
      fireEvent(f, down);
      expect(down.defaultPrevented).toBe(true);
      expect(pos()).toEqual([x0, y0 - 40]);
      fireEvent(f, new WheelEvent('wheel', { deltaY: 30, shiftKey: true, bubbles: true, cancelable: true }));
      expect(pos()).toEqual([x0 - 30, y0 - 40]);
      fireEvent(f, new WheelEvent('wheel', { deltaX: -20, bubbles: true, cancelable: true }));
      expect(pos()).toEqual([x0 - 10, y0 - 40]);
    });
  });

  it('wheel events that arrive before a re-render all count (trackpad pinch)', () => {
    render(<DiagramViewer svg={SVG} code={CODE} />);
    const f = frame();
    act(() => {
      for (let i = 0; i < 2; i++) f.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true }));
    });
    expect(img().style.width).toBe(`${Math.round(400 * Math.exp(0.25) ** 2)}px`);
  });

  it('pinches with two fingers', () => {
    withFrameWidth(600, () => {
      render(<DiagramViewer svg={SVG} code={CODE} />);
      const f = frame();
      fireEvent.pointerDown(f, { pointerId: 1, pointerType: 'touch', clientX: 250, clientY: 116 });
      fireEvent.pointerDown(f, { pointerId: 2, pointerType: 'touch', clientX: 350, clientY: 116 });
      // The second finger moves away: the distance doubles.
      fireEvent.pointerMove(f, { pointerId: 2, clientX: 450, clientY: 116 });
      expect(img().style.width).toBe('800px');
      fireEvent.pointerUp(f, { pointerId: 2 });
      // One finger left: it pans again.
      const [x, y] = pos();
      fireEvent.pointerMove(f, { pointerId: 1, clientX: 240, clientY: 106 });
      expect(pos()).toEqual([x - 10, y - 10]);
      fireEvent.pointerUp(f, { pointerId: 1 });
      expect(f.className).not.toContain('panning');
    });
  });

  it('a zoom during a drag is kept, and a lost pointer capture ends the drag', () => {
    withFrameWidth(600, () => {
      render(<DiagramViewer svg={SVG} code={CODE} />);
      const f = frame();
      fireEvent.pointerDown(f, { button: 0, pointerId: 1, pointerType: 'mouse', clientX: 100, clientY: 100 });
      fireEvent.keyDown(f, { key: '+' });
      const [x, y] = pos();
      fireEvent.pointerMove(f, { pointerId: 1, clientX: 110, clientY: 105 });
      expect(pos()).toEqual([x + 10, y + 5]);
      fireEvent.lostPointerCapture(f, { pointerId: 1 });
      expect(f.className).not.toContain('panning');
      fireEvent.pointerMove(f, { pointerId: 1, clientX: 300, clientY: 300 });
      expect(pos()).toEqual([x + 10, y + 5]);
    });
  });

  it('zoom-out never enlarges a very wide diagram that fits below the usual minimum', () => {
    const wide = '<svg viewBox="0 0 6000 300" style="max-width: 6000px;"></svg>';
    withFrameWidth(332, () => {
      render(<DiagramViewer svg={wide} code={CODE} />);
      // (332 - 32) / 6000 = 5%
      expect(img().style.width).toBe('300px');
      fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
      expect(img().style.width).toBe('300px');
    });
  });

  it('shows the source instead of the diagram and back', () => {
    render(<DiagramViewer svg={SVG} code={CODE} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show source' }));
    expect(screen.getByText(/flowchart TB/)).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show source' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Download SVG' }));
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
    const open = screen.getByRole('button', { name: 'Full screen' });
    fireEvent.click(open);
    expect(screen.getByRole('dialog', { name: 'Mermaid diagram (full screen)' })).toBeTruthy();
    expect(root.hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close full screen' }));

    const pageKeys = vi.fn();
    window.addEventListener('keydown', pageKeys);
    fireEvent.keyDown(document, { key: 'Escape' });
    window.removeEventListener('keydown', pageKeys);
    expect(pageKeys).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(root.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(open);

    fireEvent.click(open);
    fireEvent.click(screen.getByRole('button', { name: 'Close full screen' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    unmount();
    expect(root.hasAttribute('inert')).toBe(false);
    expect(document.querySelector('.diagram-overlay')).toBeNull();
  });
});
