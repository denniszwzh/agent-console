// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async (_id: string, _code: string) => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' })),
}));
vi.mock('mermaid', () => ({ default: mermaidMock }));

import { Markdown } from '../../src/web/components/Markdown.js';

afterEach(cleanup);

describe('Markdown', () => {
  it('Markdown does not render raw html', () => {
    const { container } = render(<Markdown content={'Hello <script>alert(1)</script> <b>bold</b>'} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('<script>');
  });

  it('mermaid block renders via Mermaid component', async () => {
    render(<Markdown content={'```mermaid\ngraph TD; A-->B\n```'} />);
    await waitFor(() => expect(mermaidMock.render).toHaveBeenCalled());
    expect(mermaidMock.render.mock.calls[0][1]).toBe('graph TD; A-->B');
    expect(mermaidMock.initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: 'strict' }));
    const img = await screen.findByRole('img', { name: 'Mermaid 圖表' });
    expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it('shows source and error when mermaid fails', async () => {
    mermaidMock.render.mockRejectedValueOnce(new Error('Parse error on line 1'));
    render(<Markdown content={'```mermaid\nnot a graph\n```'} />);
    expect(await screen.findByText(/Parse error on line 1/)).toBeTruthy();
    expect(screen.getByText('not a graph')).toBeTruthy();
  });

  it('svg block renders as a data image', () => {
    render(<Markdown content={'```svg\n<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>\n```'} />);
    const img = screen.getByRole('img');
    expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it('rewrites local images and refuses remote ones', () => {
    const { container } = render(
      <Markdown
        content={'![local](img/a.png) ![win](<C:\\pics\\b.png>) ![remote](https://example.com/c.png)'}
        imageUrl={(p) => `/api/units/u1/image?path=${encodeURIComponent(p)}`}
      />,
    );
    const srcs = [...container.querySelectorAll('img')].map((i) => i.getAttribute('src'));
    expect(srcs).toEqual([
      '/api/units/u1/image?path=img%2Fa.png',
      `/api/units/u1/image?path=${encodeURIComponent('C:\\pics\\b.png')}`,
    ]);
    expect(container.textContent).toContain('remote');
  });

  it('keeps the rendered code block and link DOM across re-renders (a text selection survives)', () => {
    const content = '```ts\nconst a = 1;\n```\n\n[link](https://example.com)';
    const { container, rerender } = render(<Markdown content={content} imageUrl={(p) => `/a/${p}`} />);
    const pre = container.querySelector('pre');
    const link = container.querySelector('a');
    rerender(<Markdown content={content} imageUrl={(p) => `/b/${p}`} />);
    expect(container.querySelector('pre')).toBe(pre);
    expect(container.querySelector('a')).toBe(link);
  });

  it('uses the latest imageUrl after a re-render', () => {
    const { container, rerender } = render(<Markdown content={'![x](img/a.png)'} imageUrl={(p) => `/a/${p}`} />);
    rerender(<Markdown content={'![x](img/a.png)'} imageUrl={(p) => `/b/${p}`} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/b/img/a.png');
  });
});
