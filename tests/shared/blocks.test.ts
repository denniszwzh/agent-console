import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { splitBlocks } from '../../src/shared/blocks.js';

describe('splitBlocks', () => {
  it('splits headings, paragraphs and list items', () => {
    const blocks = splitBlocks('# A\n\npara\n\n- x\n- y\n', 'markdown');
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'listItem', 'listItem']);
    expect(blocks[3].headingPath).toEqual(['A']);
    expect(blocks[0].headingPath).toEqual([]);
  });

  it('tracks nested heading paths', () => {
    const blocks = splitBlocks('# 1 Intro\n\n## 1.1 Sub\n\ntext\n\n# 2 Next\n\nmore\n', 'markdown');
    expect(blocks[1].headingPath).toEqual(['1 Intro']);
    expect(blocks[2].headingPath).toEqual(['1 Intro', '1.1 Sub']);
    expect(blocks[3].headingPath).toEqual([]);
    expect(blocks[4].headingPath).toEqual(['2 Next']);
  });

  it('ids are stable across re-splits and unaffected by edits elsewhere', () => {
    const base = '# A\n\npara one\n\n- x\n';
    const a = splitBlocks(base, 'markdown');
    const b = splitBlocks(base + '\nnew tail paragraph\n', 'markdown');
    expect(splitBlocks(base, 'markdown').map((x) => x.id)).toEqual(a.map((x) => x.id));
    expect(b.slice(0, a.length).map((x) => x.id)).toEqual(a.map((x) => x.id));
  });

  it('duplicate paragraphs get distinct ids', () => {
    const blocks = splitBlocks('same\n\nsame\n', 'markdown');
    expect(blocks[0].id.endsWith('-0')).toBe(true);
    expect(blocks[1].id.endsWith('-1')).toBe(true);
    expect(blocks[0].id.slice(0, 12)).toBe(blocks[1].id.slice(0, 12));
  });

  it('line ranges', () => {
    const blocks = splitBlocks('# A\n\npara\nmore\n\n- x\n- y\n', 'markdown');
    expect(blocks.map((b) => [b.startLine, b.endLine])).toEqual([[1, 1], [3, 4], [6, 6], [7, 7]]);
    expect(blocks[1].text).toBe('para\nmore');
  });

  it('fenced code is one block', () => {
    const blocks = splitBlocks('```mermaid\ngraph TD\n\nA-->B\n```\n', 'markdown');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('code');
    expect(blocks[0].endLine).toBe(5);
  });

  it('keeps nested lists inside their item', () => {
    const blocks = splitBlocks('- a\n  - b\n- c\n', 'markdown');
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toContain('- b');
  });

  it('text mode chunks long sections', () => {
    const content = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const blocks = splitBlocks(content, 'text');
    expect(blocks).toHaveLength(3);
    expect(blocks.map((b) => [b.startLine, b.endLine])).toEqual([[1, 40], [41, 80], [81, 100]]);
    expect(blocks.every((b) => b.kind === 'text' && b.headingPath.length === 0)).toBe(true);
  });

  it('text mode splits on blank lines', () => {
    const blocks = splitBlocks('a\nb\n\n\nc\n', 'text');
    expect(blocks.map((b) => [b.startLine, b.endLine])).toEqual([[1, 2], [5, 5]]);
  });
});

describe('block ids', () => {
  it('use sha1(kind + newline + normalized text) prefix, UTF-8 safe', () => {
    const [b] = splitBlocks('h\u00e9llo   w\u00f6rld \u4f60\u597d\n', 'markdown');
    const expected = createHash('sha1')
      .update('paragraph\nh\u00e9llo w\u00f6rld \u4f60\u597d')
      .digest('hex')
      .slice(0, 12);
    expect(b.id).toBe(`${expected}-0`);
  });

  it('records the ordinal of ordered list items, including lazily numbered lists', () => {
    const blocks = splitBlocks('1. a\n1. b\n1. c\n\n- x\n- y\n\n4. four\n5. five', 'markdown');
    expect(blocks.map((b) => b.ordinal)).toEqual([1, 2, 3, undefined, undefined, 4, 5]);
  });
});
