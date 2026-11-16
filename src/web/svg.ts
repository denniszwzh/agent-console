/**
 * Re-serialises SVG markup as well-formed XML. Mermaid writes HTML labels (inside <foreignObject>)
 * with HTML rules (`<br>` left open, `&nbsp;`), which a browser rejects when it loads the SVG as an
 * image, since that is strict XML. Parsing with the HTML parser and serialising with XMLSerializer
 * fixes that; parsing does not run scripts. Input without an <svg> root is returned unchanged.
 */
export function wellFormedSvg(svg: string): string {
  try {
    // Already valid XML: keep it as is (the HTML parser would restructure markup it does not expect).
    if (new DOMParser().parseFromString(svg, 'image/svg+xml').getElementsByTagName('parsererror').length === 0) return svg;
    const el = new DOMParser().parseFromString(svg, 'text/html').querySelector('svg');
    if (!el) return svg;
    // On HTML elements (the labels) `xmlns` is a plain attribute; the serializer writes the namespace
    // declaration itself, and some serializers would emit a duplicate.
    for (const node of el.querySelectorAll('[xmlns]')) {
      if (node.getAttributeNodeNS(null, 'xmlns')) node.removeAttributeNS(null, 'xmlns');
    }
    return new XMLSerializer().serializeToString(el);
  } catch {
    return svg;
  }
}

/** data: URL for SVG markup. Shown through <img>, so scripts inside never run. */
export function svgDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}
