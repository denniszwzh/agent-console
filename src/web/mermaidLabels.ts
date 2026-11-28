/**
 * Font-measured line breaking for flowchart labels.
 *
 * Mermaid wraps every label at one fixed width, and the browser breaks wherever it may: after each
 * hyphen of `agent-console-remote-host`, inside a path, or after one character of a CJK sentence. This
 * pass decides each label's lines itself before Mermaid sees the source:
 * - widths come from the real font (a measuring function the caller supplies, normally the browser's
 *   own text layout), so a wider font or a larger size gives wider boxes;
 * - a run of Latin text (`agent-console-remote-host`, `src/web/a.tsx`, `v1.2.3`) is never broken unless
 *   it alone is wider than the widest line allowed, and then only after a `-`, `/`, `_`, `.` or `:`;
 * - CJK text may break between characters, but closing punctuation stays with the character before it
 *   and opening punctuation with the one after;
 * - the number of lines is chosen so the box comes closest to a target shape (a wide rectangle,
 *   smallest for diamonds and circles), and the text is spread evenly over those lines.
 * The chosen breaks are written into the label as `<br>`, and Mermaid's wrapping width is set just above
 * the widest line, so Mermaid keeps the lines as designed. Labels this pass does not recognise (markdown
 * strings, labels with other HTML, edge labels written as `-- text -->`) keep Mermaid's own wrapping.
 */

import { diagramType } from './mermaidContrast.js';

/** Width in pixels of `text` on one line, in the label font; null when the text cannot be measured. */
export type MeasureText = (text: string) => number | null;

export interface LabelFitOptions {
  /** Label font size in pixels; the other sizes below are multiples of it (em). */
  fontSize: number;
  /** Line height, as Mermaid sets it on labels. */
  lineHeight: number;
  /** Space between the label and its box edge: Mermaid's node padding. */
  padX: number;
  padY: number;
  /** Mermaid's narrowest label (minNodeWidth); shorter text still gets a box this wide. */
  minWidth: number;
  /** Labels wrap at least at this width (labels this pass does not handle use it as is). */
  baseWidth: number;
  /** No line is made wider than this; a longer unbreakable run is split at its separators. */
  maxWidth: number;
}

/** Sizes in em, for a label font of `fontSize` pixels. */
export function labelFitOptions(fontSize: number): LabelFitOptions {
  return {
    fontSize,
    lineHeight: 1.5,
    padX: fontSize,
    padY: 0.75 * fontSize,
    minWidth: 7.5 * fontSize,
    baseWidth: 15 * fontSize,
    maxWidth: 30 * fontSize,
  };
}

/** Width / height a rectangular box looks best at. */
const BOX_RATIO = 3.5;
type ShapeKind = 'box' | 'diamond' | 'round';

/**
 * How far a label's box is from ideal (lower is better), from the label's box size:
 * - box: distance from BOX_RATIO on a log scale (twice too wide counts as much as twice too tall);
 * - diamond: Mermaid sizes it from width + height, so the smallest sum wins;
 * - round (circles): the diameter follows the larger side.
 */
function shapeCost(shape: ShapeKind, w: number, h: number): number {
  if (shape === 'diamond') return w + h;
  if (shape === 'round') return Math.max(w, h);
  return Math.abs(Math.log(w / h / BOX_RATIO));
}
/** Most lines a label is broken into. */
const MAX_LINES = 10;

interface Atom {
  text: string;
  width: number;
  /** A space separates it from the atom before (dropped when the line breaks there). */
  space: boolean;
}

const CJK = /[ᄀ-ᇿ⺀-〿぀-鿿가-힯豈-﫿︰-﹏＀-￯]/u;
/** Must not start a line. */
const CLOSING = /[，。、！？；：）」』】》〉〕…‥・,.;:!?)\]}%’”]/u;
/** Must not end a line. */
const OPENING = /[（「『【《〈〔([{‘“]/u;
/** Where an over-long Latin run may be split (after the character). */
const RUN_BREAK = /[-/_.:\\]/;

/** Splits text into pieces that are never broken inside (except over-long runs, see splitLong). */
function atomize(text: string): Omit<Atom, 'width'>[] {
  const atoms: Omit<Atom, 'width'>[] = [];
  let pendingSpace = false;
  let prevLatin = false;
  for (const ch of text) {
    if (/\s/u.test(ch)) {
      pendingSpace = atoms.length > 0;
      prevLatin = false;
      continue;
    }
    const latin = !CJK.test(ch);
    const last = atoms[atoms.length - 1];
    const join =
      last !== undefined &&
      !pendingSpace &&
      ((latin && prevLatin) || CLOSING.test(ch) || OPENING.test(last.text.slice(-1)));
    if (join) last.text += ch;
    else atoms.push({ text: ch, space: pendingSpace });
    pendingSpace = false;
    prevLatin = latin;
  }
  return atoms;
}

/** Breaks an atom wider than `max` after its separators, or anywhere as a last resort. */
function splitLong(atom: Atom, max: number, measure: (s: string) => number): Atom[] {
  if (atom.width <= max) return [atom];
  const pieces: string[] = [];
  let cur = '';
  for (const ch of atom.text) {
    cur += ch;
    if (RUN_BREAK.test(ch)) {
      pieces.push(cur);
      cur = '';
    }
  }
  if (cur) pieces.push(cur);
  // Pack separator-ended pieces into chunks no wider than max; a piece still too wide is cut by character.
  const out: Atom[] = [];
  let chunk = '';
  const flush = () => {
    if (chunk) out.push({ text: chunk, width: measure(chunk), space: out.length === 0 && atom.space });
    chunk = '';
  };
  for (const piece of pieces) {
    if (measure(chunk + piece) <= max) {
      chunk += piece;
      continue;
    }
    flush();
    if (measure(piece) <= max) {
      chunk = piece;
      continue;
    }
    for (const ch of piece) {
      if (chunk && measure(chunk + ch) > max) flush();
      chunk += ch;
    }
  }
  flush();
  return out;
}

interface Laid {
  lines: string[];
  width: number;
}

/** Greedy line filling at `width`. */
function fill(atoms: Atom[], width: number, space: number): Laid {
  const lines: string[] = [];
  let line = '';
  let lineW = 0;
  let widest = 0;
  for (const a of atoms) {
    const add = line ? (a.space ? space : 0) + a.width : a.width;
    if (line && lineW + add > width) {
      lines.push(line);
      widest = Math.max(widest, lineW);
      line = a.text;
      lineW = a.width;
    } else {
      line += line && a.space ? ' ' + a.text : a.text;
      lineW += add;
    }
  }
  if (line) {
    lines.push(line);
    widest = Math.max(widest, lineW);
  }
  return { lines, width: widest };
}

/** Narrowest width at which `atoms` fill at most `n` lines. */
function widthForLines(atoms: Atom[], n: number, space: number, natural: number): number {
  let lo = Math.max(...atoms.map((a) => a.width), natural / n);
  let hi = natural;
  if (fill(atoms, lo, space).lines.length <= n) return lo;
  while (hi - lo > 0.5) {
    const mid = (lo + hi) / 2;
    if (fill(atoms, mid, space).lines.length <= n) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * Lines for one label: each forced line (`<br>` in the source) is filled at one shared width, chosen
 * so the box comes closest to the shape's target ratio. Null when the text cannot be measured.
 */
export function layoutLabel(text: string, measureText: MeasureText, opts: LabelFitOptions, shape: ShapeKind = 'box'): Laid | null {
  const space = measureText(' ');
  if (space === null) return null;
  const cache = new Map<string, number>();
  let failed = false;
  const measure = (s: string) => {
    let w = cache.get(s);
    if (w === undefined) {
      const m = measureText(s);
      if (m === null) failed = true;
      w = m ?? 0;
      cache.set(s, w);
    }
    return w;
  };
  const segments = text
    .split(/<br\s*\/?>|\n/i)
    .map((seg) => atomize(seg).flatMap((a) => splitLong({ ...a, width: measure(a.text) }, opts.maxWidth, measure)))
    .filter((atoms) => atoms.length > 0);
  if (failed || segments.length === 0) return null;

  const naturals = segments.map((atoms) => fill(atoms, Infinity, space).width);
  const candidates = new Set<number>();
  segments.forEach((atoms, i) => {
    for (let n = 1; n <= MAX_LINES; n++) candidates.add(Math.ceil(widthForLines(atoms, n, space, naturals[i])));
  });
  const lineH = opts.lineHeight * opts.fontSize;
  const fitting = [...candidates].filter((w) => w <= opts.maxWidth);
  let best: (Laid & { score: number }) | null = null;
  // Widest first, so a tie keeps the fewer lines.
  for (const w of (fitting.length ? fitting : [...candidates]).sort((a, b) => b - a)) {
    const parts = segments.map((atoms) => fill(atoms, w, space));
    const lines = parts.flatMap((p) => p.lines);
    const width = Math.max(...parts.map((p) => p.width));
    const boxW = Math.max(width, opts.minWidth) + 2 * opts.padX;
    const boxH = lines.length * lineH + 2 * opts.padY;
    const score = shapeCost(shape, boxW, boxH);
    if (!best || score < best.score - 1e-9) best = { lines, width, score };
  }
  return best && { lines: best.lines, width: best.width };
}

/** Flowchart node shapes: opener, closer and the shape they look like. Longest openers first. */
const SHAPES: [string, string, ShapeKind][] = [
  ['(((', ')))', 'round'],
  ['([', '])', 'box'],
  ['[[', ']]', 'box'],
  ['[(', ')]', 'box'],
  ['((', '))', 'round'],
  ['{{', '}}', 'box'],
  ['[/', '/]', 'box'],
  ['[/', '\\]', 'box'],
  ['[\\', '\\]', 'box'],
  ['[\\', '/]', 'box'],
  ['[', ']', 'box'],
  ['(', ')', 'box'],
  ['{', '}', 'diamond'],
];

/** A node id right before a shape: letters, digits, `_`, and `-` / `.` between them (not an arrow). */
const NODE_ID = /[\p{L}\p{N}_]+(?:[.-][\p{L}\p{N}_]+)*$/u;
/** Lines that hold no node labels (or whose brackets mean something else). */
const SKIP_LINE = /^\s*(%%|style\b|classDef\b|class\b|click\b|linkStyle\b|subgraph\b|direction\b|accTitle\b|accDescr\b|end\s*$)/;

interface Found {
  start: number;
  end: number;
  text: string;
  quoted: boolean;
  shape: ShapeKind;
}

/** Labels on one flowchart line: node shapes after an id, and edge labels between pipes. */
function findLabels(line: string): Found[] {
  const found: Found[] = [];
  let i = 0;
  while (i < line.length) {
    const shape = SHAPES.find(([open]) => line.startsWith(open, i));
    if (shape && NODE_ID.test(line.slice(0, i)) && line[i - 1] !== '@') {
      const [open, , kind] = shape;
      const start = i + open.length;
      const hit = labelAt(line, start, SHAPES.filter(([o]) => o === open).map(([, c]) => c));
      if (hit) {
        found.push({ start, end: hit.end, text: hit.text, quoted: hit.quoted, shape: kind });
        i = hit.end;
        continue;
      }
    }
    if (line[i] === '|') {
      const hit = labelAt(line, i + 1, ['|']);
      if (hit) {
        found.push({ start: i + 1, end: hit.end, text: hit.text, quoted: hit.quoted, shape: 'box' });
        i = hit.end + 1;
        continue;
      }
    }
    i++;
  }
  return found;
}

/** The label text starting at `start`, quoted or not, ending right before one of `closers`. */
function labelAt(line: string, start: number, closers: string[]): { end: number; text: string; quoted: boolean } | null {
  if (line[start] === '"') {
    const q = line.indexOf('"', start + 1);
    if (q < 0 || !closers.some((c) => line.startsWith(c, q + 1))) return null;
    return { end: q + 1, text: line.slice(start + 1, q), quoted: true };
  }
  for (let j = start; j < line.length; j++) {
    if (closers.some((c) => line.startsWith(c, j))) return { end: j, text: line.slice(start, j), quoted: false };
    if ('[](){}|"'.includes(line[j])) return null;
  }
  return null;
}

/** Text the pass may re-break: plain text with only `<br>` tags, and no markdown string. */
function plainLabel(text: string): boolean {
  return !text.startsWith('`') && !/<(?!br\s*\/?>)/i.test(text) && text.trim().length > 0;
}

const isFlowchart = (code: string) => /^(flowchart|graph|flowchart-elk)$/.test(diagramType(code.split('\n')));

export interface FittedLabels {
  code: string;
  /** Mermaid's `flowchart.wrappingWidth` for this diagram. */
  wrappingWidth: number;
}

/**
 * The flowchart with each recognised label broken into lines by the rules in the file comment, and the
 * wrapping width that keeps those lines intact. Other diagrams, and text that cannot be measured, come
 * back unchanged with the base width.
 */
export function fitFlowchartLabels(code: string, measureText: MeasureText, opts: LabelFitOptions): FittedLabels {
  const unchanged = { code, wrappingWidth: opts.baseWidth };
  if (!isFlowchart(code)) return unchanged;
  let widest = 0;
  let measured = true;
  const out = code.split('\n').map((rawLine) => {
    if (!measured || SKIP_LINE.test(rawLine)) return rawLine;
    let line = rawLine;
    // Right to left, so earlier offsets stay valid.
    for (const f of findLabels(rawLine).reverse()) {
      if (!plainLabel(f.text)) continue;
      const laid = layoutLabel(f.text, measureText, opts, f.shape);
      if (!laid) {
        measured = false;
        return rawLine;
      }
      widest = Math.max(widest, laid.width);
      const body = laid.lines.join('<br>');
      line = line.slice(0, f.start) + (f.quoted ? `"${body}"` : body) + line.slice(f.end);
    }
    return line;
  });
  if (!measured) return unchanged;
  // A little room over the widest designed line, so Mermaid's own measurement never wraps it again.
  const wrappingWidth = Math.max(opts.baseWidth, Math.ceil(widest + opts.fontSize / 2));
  return { code: out.join('\n'), wrappingWidth };
}
