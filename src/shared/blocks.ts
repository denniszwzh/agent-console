import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Block } from './types.js';

const TEXT_CHUNK_LINES = 40;

// Minimal pure-JS SHA-1 so this module works in both Node and the browser.
function sha1Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const len = bytes.length;
  const padded = new Uint8Array((((len + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((len * 8) / 0x100000000));
  view.setUint32(padded.length - 4, (len * 8) >>> 0);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((n) => n.toString(16).padStart(8, '0')).join('');
}

interface RawBlock {
  kind: string;
  text: string;
  startLine: number;
  endLine: number;
  headingPath: string[];
  ordinal?: number;
}

function assignIds(raw: RawBlock[]): Block[] {
  const seen = new Map<string, number>();
  return raw.map((b) => {
    const normalized = b.text.trim().replace(/\s+/g, ' ');
    const hash = sha1Hex(b.kind + '\n' + normalized).slice(0, 12);
    const n = seen.get(hash) ?? 0;
    seen.set(hash, n + 1);
    return { id: `${hash}-${n}`, ...b };
  });
}

// Plain text of a mdast node (used for heading paths).
function plainText(node: any): string {
  if (typeof node.value === 'string') return node.value;
  if (Array.isArray(node.children)) return node.children.map(plainText).join('');
  return '';
}

function splitMarkdown(content: string): Block[] {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(content);
  const raw: RawBlock[] = [];
  const path: { depth: number; title: string }[] = [];
  const push = (node: any, headingPath: string[], ordinal?: number) => {
    const pos = node.position;
    const block: RawBlock = {
      kind: node.type,
      text: content.slice(pos.start.offset, pos.end.offset),
      startLine: pos.start.line,
      endLine: pos.end.line,
      headingPath,
    };
    if (ordinal !== undefined) block.ordinal = ordinal;
    raw.push(block);
  };
  for (const node of tree.children as any[]) {
    if (!node.position) continue;
    if (node.type === 'heading') {
      while (path.length && path[path.length - 1].depth >= node.depth) path.pop();
      push(node, path.map((p) => p.title));
      path.push({ depth: node.depth, title: plainText(node).trim() });
    } else if (node.type === 'list') {
      // Ordered items are split apart, so each keeps its number in the list.
      const start = typeof node.start === 'number' ? node.start : 1;
      node.children.forEach((item: any, i: number) =>
        push(item, path.map((p) => p.title), node.ordered ? start + i : undefined),
      );
    } else {
      push(node, path.map((p) => p.title));
    }
  }
  return assignIds(raw);
}

function splitText(content: string): Block[] {
  const lines = content.split(/\r?\n/);
  const raw: RawBlock[] = [];
  let start = -1;
  const flush = (endExclusive: number) => {
    if (start < 0) return;
    for (let s = start; s < endExclusive; s += TEXT_CHUNK_LINES) {
      const e = Math.min(s + TEXT_CHUNK_LINES, endExclusive);
      raw.push({
        kind: 'text',
        text: lines.slice(s, e).join('\n'),
        startLine: s + 1,
        endLine: e,
        headingPath: [],
      });
    }
    start = -1;
  };
  lines.forEach((line, i) => {
    if (line.trim() === '') flush(i);
    else if (start < 0) start = i;
  });
  flush(lines.length);
  return assignIds(raw);
}

export function splitBlocks(content: string, mode: 'markdown' | 'text'): Block[] {
  return mode === 'markdown' ? splitMarkdown(content) : splitText(content);
}
