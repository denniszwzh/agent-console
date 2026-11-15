import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { takeSnapshot } from '../../src/server/snapshot.js';

const dir = mkdtempSync(join(tmpdir(), 'snap-'));

describe('takeSnapshot', () => {
  it('truncates files larger than 1 MB', () => {
    writeFileSync(join(dir, 'big.txt'), 'a'.repeat(1_500_000));
    const s = takeSnapshot(join(dir, 'big.txt'), dir);
    expect(s.truncated).toBe(true);
    expect(s.content.length).toBe(1_048_576);
    expect(s.kind).toBe('file');
  });

  it('marks files with NUL bytes as binary', () => {
    writeFileSync(join(dir, 'x.bin'), Buffer.from([1, 2, 0, 3]));
    const s = takeSnapshot('x.bin', dir);
    expect(s.binary).toBe(true);
    expect(s.content).toBe('');
  });

  it('marks raster images as binary images and svg as text image', () => {
    writeFileSync(join(dir, 'p.png'), Buffer.from([0x89, 0x50, 0, 0]));
    const p = takeSnapshot('p.png', dir);
    expect(p.image).toBe(true);
    expect(p.binary).toBe(true);
    writeFileSync(join(dir, 'v.svg'), '<svg></svg>');
    const v = takeSnapshot('v.svg', dir);
    expect(v.image).toBe(true);
    expect(v.binary).toBeUndefined();
    expect(v.content).toBe('<svg></svg>');
  });

  it('returns an error instead of throwing for missing files', () => {
    const s = takeSnapshot('nope.txt', dir);
    expect(s.error).toBeTruthy();
    expect(s.path).toBe('nope.txt');
  });

  it('splits markdown files into blocks and sets language', () => {
    writeFileSync(join(dir, 'a.md'), '# Title\n\nbody\n');
    const s = takeSnapshot('a.md', dir);
    expect(s.blocks[0].kind).toBe('heading');
    expect(s.language).toBe('md');
    const t = takeSnapshot(join(dir, 'big.txt'), dir);
    expect(t.language).toBe('txt');
  });
});
