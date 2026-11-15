/** MIME types for the image extensions the panel will display. */
export const IMAGE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

/** Extensions treated as images everywhere (snapshots, the image endpoint, the UI). */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(IMAGE_CONTENT_TYPES));

/**
 * True for a relative or absolute filesystem path. URLs with a scheme
 * (http:, https:, data:, file:, ...), protocol-relative URLs and UNC paths are
 * rejected so that nothing is ever fetched from another host.
 */
export function isLocalImagePath(ref: string): boolean {
  const p = ref.trim();
  if (!p) return false;
  if (/^[\\/]{2}/.test(p)) return false; // UNC or protocol-relative
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true; // Windows drive path
  return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p);
}

/** Lower-case extension without the dot, or '' when there is none. */
export function imageExtension(ref: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(ref);
  return m ? m[1].toLowerCase() : '';
}
