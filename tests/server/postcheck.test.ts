import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultGitStatus, parsePorcelainZ } from '../../src/server/postcheck.js';

const NUL = String.fromCharCode(0);
const z = (...records: string[]) => records.join(NUL) + NUL;

describe('parsePorcelainZ', () => {
  it('keeps raw paths (spaces, arrows, non-ASCII) and skips rename/copy sources', () => {
    const out = z(' M a b.md', 'R  new.md', 'old.md', 'C  copy.md', 'orig.md', '?? 中文 -> x.md', ' D gone.md');
    expect([...parsePorcelainZ(out)]).toEqual([
      ['a b.md', ' M'],
      ['new.md', 'R '],
      ['copy.md', 'C '],
      ['中文 -> x.md', '??'],
      ['gone.md', ' D'],
    ]);
  });

  it('returns an empty map for empty output', () => {
    expect(parsePorcelainZ('').size).toBe(0);
  });
});

describe('defaultGitStatus', () => {
  it('returns null outside a git work tree', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-nogit-'));
    try {
      // GIT_CEILING_DIRECTORIES keeps git from finding a repository above the temp dir.
      const prev = process.env.GIT_CEILING_DIRECTORIES;
      process.env.GIT_CEILING_DIRECTORIES = path.dirname(dir);
      try {
        expect(await defaultGitStatus(dir)).toBeNull();
      } finally {
        if (prev === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
        else process.env.GIT_CEILING_DIRECTORIES = prev;
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
