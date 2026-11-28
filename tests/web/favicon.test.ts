import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const webDir = fileURLToPath(new URL('../../src/web/', import.meta.url));

describe('panel favicon', () => {
  it('index.html links an SVG icon served from the site root', () => {
    const html = readFileSync(`${webDir}index.html`, 'utf8');
    expect(html).toMatch(/<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg" \/>/);
  });

  it('ships the icon in the Vite public folder, so the build copies it to the web root', () => {
    const file = `${webDir}public/favicon.svg`;
    expect(existsSync(file)).toBe(true);
    const svg = readFileSync(file, 'utf8');
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 512 512">/);
    // The CSP allows only same-origin and data: images, so the icon must not pull in anything external.
    expect(svg).not.toMatch(/href=|url\(http/);
  });
});
