import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileAtomic } from '../../src/server/remote/fs-atomic.js';

describe('writeFileAtomic', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-atomic-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('writes the content, replaces an existing file and leaves no tmp file', () => {
    const file = path.join(dir, 'a.json');
    writeFileAtomic(file, 'one');
    writeFileAtomic(file, 'two');
    expect(fs.readFileSync(file, 'utf8')).toBe('two');
    expect(fs.readdirSync(dir)).toEqual(['a.json']);
  });

  it('rethrows and leaves no tmp file when the target is a directory', () => {
    const file = path.join(dir, 'target');
    fs.mkdirSync(file);
    expect(() => writeFileAtomic(file, 'x')).toThrow();
    expect(fs.readdirSync(dir)).toEqual(['target']);
  });
});
