/** data: URL for SVG markup. Shown through <img>, so scripts inside never run. */
export function svgDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}
