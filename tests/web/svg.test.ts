// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { wellFormedSvg } from '../../src/web/svg.js';

const parsesAsXml = (s: string) => new DOMParser().parseFromString(s, 'image/svg+xml').getElementsByTagName('parsererror').length === 0;

// Mermaid serialises HTML labels (inside <foreignObject>) with HTML rules: `<br>` is never closed and
// `&nbsp;` may appear. A browser loads an <img> SVG as strict XML, so such markup breaks the image.
const MERMAID_LIKE =
  '<svg id="m" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g><foreignObject width="10" height="10">' +
  '<div xmlns="http://www.w3.org/1999/xhtml" style="display: table-cell;"><span class="nodeLabel"><p>使用者<br>主工作階段&nbsp;A &amp; B</p></span></div>' +
  '</foreignObject><path d="M0 0L1 1"/></g></svg>';

describe('wellFormedSvg', () => {
  it('turns HTML-serialised labels into XML a browser can load as an image', () => {
    expect(parsesAsXml(MERMAID_LIKE)).toBe(false);
    const out = wellFormedSvg(MERMAID_LIKE);
    expect(parsesAsXml(out)).toBe(true);
    const doc = new DOMParser().parseFromString(out, 'image/svg+xml');
    expect(doc.documentElement.getAttribute('viewBox')).toBe('0 0 10 10');
    expect(doc.getElementsByTagName('p')[0].textContent).toBe('使用者主工作階段 A & B');
    expect(doc.getElementsByTagName('br')).toHaveLength(1);
    expect(doc.getElementsByTagName('path')).toHaveLength(1);
  });

  it('returns already well-formed SVG unchanged and leaves non-SVG input alone', () => {
    const plain = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><circle r="2"/></svg>';
    expect(wellFormedSvg(plain)).toBe(plain);
    expect(wellFormedSvg('not svg')).toBe('not svg');
  });

  it('keeps styles with child selectors and xlink references when it has to re-serialise', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><style>#m .label > p { color: red; }</style>' +
      '<use xlink:href="#a"/><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><p>x<br>y</p></div></foreignObject></svg>';
    const doc = new DOMParser().parseFromString(wellFormedSvg(svg), 'image/svg+xml');
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
    expect(doc.getElementsByTagName('style')[0].textContent).toBe('#m .label > p { color: red; }');
    expect(doc.getElementsByTagName('use')[0].getAttributeNS('http://www.w3.org/1999/xlink', 'href')).toBe('#a');
  });
});
