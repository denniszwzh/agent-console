/**
 * Keeps Mermaid text readable when a diagram brings its own colours.
 *
 * Diagram authors often colour boxes with `style` / `classDef` (`fill:#e1f5fe`) for a light page and
 * leave the text colour to the theme. In dark mode the theme's text is light, so it lands on a light
 * box and nearly disappears; the reverse happens with dark fills in light mode. This pass rewrites the
 * diagram source before Mermaid sees it, so Mermaid itself lays out and colours the labels:
 * - `style` / `classDef` with a fill: add a `color` that contrasts with the fill when the theme's text
 *   does not, and replace an explicit `color` that is close to unreadable on its own fill;
 * - sequence `rect` highlight regions, whose messages always use the theme's text colour: mix the
 *   region's colour toward the page background until the text reads well (the tint stays).
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface ContrastPalette {
  /** Diagram background, used under translucent colours and as the mixing target for `rect` regions. */
  background: string;
  /** The theme's text colour, used on boxes that set no colour of their own. */
  text: string;
  /** Text colours to choose from for a box whose fill does not suit the theme's text. */
  darkText: string;
  lightText: string;
}

/** WCAG AA for normal text. */
const MIN_THEME_CONTRAST = 4.5;
/** An author's own text colour is kept unless it is close to unreadable on its fill. */
const MIN_AUTHOR_CONTRAST = 3;

interface Rgba extends Rgb {
  a: number;
}

const clamp255 = (v: number) => Math.max(0, Math.min(255, v));

function parseHex(s: string): Rgba | null {
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (!m) return null;
  let h = m[1];
  if (h.length <= 4) h = [...h].map((c) => c + c).join('');
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
}

function parseFunctional(s: string): Rgba | null {
  const m = /^(rgba?|hsla?)\(([^)]*)\)$/i.exec(s);
  if (!m) return null;
  const parts = m[2].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const num = (p: string, scale: number) => (p.endsWith('%') ? (parseFloat(p) / 100) * scale : parseFloat(p));
  const a = parts.length > 3 ? num(parts[3], 1) : 1;
  if (m[1].toLowerCase().startsWith('rgb')) {
    const [r, g, b] = parts.slice(0, 3).map((p) => clamp255(num(p, 255)));
    return [r, g, b, a].some(Number.isNaN) ? null : { r, g, b, a };
  }
  const h = (((parseFloat(parts[0]) % 360) + 360) % 360) / 360;
  const sat = num(parts[1], 1);
  const l = num(parts[2], 1);
  if ([h, sat, l, a].some(Number.isNaN)) return null;
  const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat;
  const p = 2 * l - q;
  const ch = (t: number) => {
    t = (t + 1) % 1;
    const v = t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
    return clamp255(v * 255);
  };
  return { r: ch(h + 1 / 3), g: ch(h), b: ch(h - 1 / 3), a };
}

let probe: HTMLElement | null = null;
const named = new Map<string, Rgba | null>();

/** Colour names (`lightblue`, ...), resolved by the browser itself. */
function parseNamed(s: string): Rgba | null {
  if (!/^[a-z]+$/i.test(s) || typeof document === 'undefined' || !document.body) return null;
  const key = s.toLowerCase();
  if (named.has(key)) return named.get(key) ?? null;
  probe ??= document.createElement('span');
  probe.style.color = '';
  probe.style.color = key;
  let out: Rgba | null = null;
  if (probe.style.color) {
    document.body.appendChild(probe);
    const computed = getComputedStyle(probe).color;
    probe.remove();
    out = parseHex(computed) ?? parseFunctional(computed);
  }
  named.set(key, out);
  return out;
}

function parseRgba(value: string): Rgba | null {
  const s = value
    .replace(/\\,/g, ',')
    .replace(/!important/i, '')
    .trim();
  if (!s || /^(none|transparent|inherit|initial|unset|currentcolor)$/i.test(s)) return null;
  return parseHex(s) ?? parseFunctional(s) ?? parseNamed(s);
}

/** Parses a CSS colour (hex, rgb(), hsl() or a colour name), composited over `background` when translucent. */
export function parseColor(value: string, background?: Rgb): Rgb | null {
  const c = parseRgba(value);
  if (!c) return null;
  if (c.a >= 1 || !background) return { r: c.r, g: c.g, b: c.b };
  return mix({ r: c.r, g: c.g, b: c.b }, background, 1 - Math.max(0, c.a));
}

function luminance({ r, g, b }: Rgb): number {
  const f = (v: number) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG contrast ratio, 1 to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** `a` moved toward `b` by `t` (0 = a, 1 = b). */
function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const m = (x: number, y: number) => Math.round(x + (y - x) * t);
  return { r: m(a.r, b.r), g: m(a.g, b.g), b: m(a.b, b.b) };
}

const toCss = ({ r, g, b }: Rgb) => `rgb(${r}, ${g}, ${b})`;

interface Resolved {
  background: Rgb;
  text: Rgb;
  darkText: string;
  lightText: string;
  dark: Rgb;
  light: Rgb;
}

function resolve(p: ContrastPalette): Resolved | null {
  const background = parseColor(p.background);
  const text = parseColor(p.text);
  const dark = parseColor(p.darkText);
  const light = parseColor(p.lightText);
  if (!background || !text || !dark || !light) return null;
  return { background, text, darkText: p.darkText, lightText: p.lightText, dark, light };
}

/** The palette's dark or light text, whichever reads better on `fill`. */
function bestText(fill: Rgb, p: Resolved): string {
  return contrastRatio(fill, p.dark) >= contrastRatio(fill, p.light) ? p.darkText : p.lightText;
}

/** Splits a Mermaid style list on commas that are not escaped (`\,`) or inside parentheses. */
function splitStyles(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0 && list[i - 1] !== '\\') {
      out.push(list.slice(start, i));
      start = i + 1;
    }
  }
  out.push(list.slice(start));
  return out;
}

const STYLE_LINE = /^(\s*(?:style|classDef)\s+\S+\s+)(.*?)(\s*;?\s*)$/;

function fixStyleLine(line: string, p: Resolved): string {
  const m = STYLE_LINE.exec(line);
  if (!m) return line;
  const entries = splitStyles(m[2]);
  const keyOf = (e: string) => e.slice(0, e.indexOf(':')).trim().toLowerCase();
  const valueOf = (e: string) => e.slice(e.indexOf(':') + 1);
  const fillEntry = entries.find((e) => e.includes(':') && keyOf(e) === 'fill');
  const fill = fillEntry ? parseColor(valueOf(fillEntry), p.background) : null;
  if (!fill) return line;
  const colorIndex = entries.findIndex((e) => e.includes(':') && keyOf(e) === 'color');
  if (colorIndex >= 0) {
    const own = parseColor(valueOf(entries[colorIndex]), fill);
    if (!own || contrastRatio(own, fill) >= MIN_AUTHOR_CONTRAST) return line;
    entries[colorIndex] = `color:${bestText(fill, p)}`;
  } else {
    if (contrastRatio(p.text, fill) >= MIN_THEME_CONTRAST) return line;
    entries.push(`color:${bestText(fill, p)}`);
  }
  return m[1] + entries.join(',') + m[3];
}

const RECT_LINE = /^(\s*rect\s+)(.+?)(\s*)$/;

/** A sequence `rect` colour the theme's text can be read on: the least mix toward the background that does it. */
function fixRectLine(line: string, p: Resolved): string {
  const m = RECT_LINE.exec(line);
  if (!m) return line;
  const color = parseColor(m[2], p.background);
  if (!color || contrastRatio(p.text, color) >= MIN_THEME_CONTRAST) return line;
  for (let t = 0.1; t < 1; t += 0.05) {
    const mixed = mix(color, p.background, t);
    if (contrastRatio(p.text, mixed) >= MIN_THEME_CONTRAST) return m[1] + toCss(mixed) + m[3];
  }
  return m[1] + toCss(p.background) + m[3];
}

/** The diagram keyword (`flowchart`, `sequenceDiagram`, ...): the first line that is not blank, a comment, a directive or front matter. */
export function diagramType(lines: string[]): string {
  let inFrontMatter = false;
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (i === 0 && line === '---') {
      inFrontMatter = true;
      continue;
    }
    if (inFrontMatter) {
      if (line === '---') inFrontMatter = false;
      continue;
    }
    if (!line || line.startsWith('%%')) continue;
    return line.split(/\s/)[0];
  }
  return '';
}

/** Mermaid source with author colours adjusted so every label reads well on its box (see the file comment). */
export function readableMermaid(code: string, palette: ContrastPalette): string {
  const p = resolve(palette);
  if (!p || !/\b(style|classDef|rect)\b/.test(code)) return code;
  const lines = code.split('\n');
  const sequence = diagramType(lines) === 'sequenceDiagram';
  return lines
    .map((line) => {
      const body = line.endsWith('\r') ? line.slice(0, -1) : line;
      const cr = body === line ? '' : '\r';
      if (STYLE_LINE.test(body)) return fixStyleLine(body, p) + cr;
      if (sequence && RECT_LINE.test(body)) return fixRectLine(body, p) + cr;
      return line;
    })
    .join('\n');
}
