import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { projectOf } from '../../src/server/project.js';
import { pathKey } from '../../src/server/paths.js';

let root: string;
let repo: string;
beforeEach(() => {
  root = resolve(mkdtempSync(join(tmpdir(), 'ac-project-')));
  repo = join(root, 'repo');
  mkdirSync(join(repo, '.git', 'worktrees', 'feat-x'), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('projectOf', () => {
  it('uses the folder holding .git', () => {
    const cwd = join(repo, 'src', 'web');
    mkdirSync(cwd, { recursive: true });
    expect(projectOf(cwd)).toEqual({ key: pathKey(repo), root: repo });
  });

  it('maps a git worktree to its main repository', () => {
    const wt = join(root, 'wt-abs');
    mkdirSync(wt);
    writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'feat-x').replace(/\\/g, '/')}\n`);
    expect(projectOf(wt)).toEqual({ key: pathKey(repo), root: repo, worktree: 'wt-abs' });
  });

  it('resolves a relative gitdir against the worktree folder', () => {
    const wt = join(root, 'wt-rel');
    mkdirSync(join(wt, 'sub'), { recursive: true });
    writeFileSync(join(wt, '.git'), 'gitdir: ../repo/.git/worktrees/feat-x');
    expect(projectOf(join(wt, 'sub'))).toEqual({ key: pathKey(repo), root: repo, worktree: 'wt-rel' });
  });

  it('names a deleted worktree under a real repository', () => {
    const gone = join(repo, '.claude', 'worktrees', 'abc');
    expect(projectOf(gone)).toEqual({ key: pathKey(repo), root: repo, worktree: 'abc' });
    expect(projectOf(join(gone, 'deeper'))).toMatchObject({ root: repo, worktree: 'abc' });
  });

  it('falls back to the worktree path pattern without any .git', () => {
    const plain = join(root, 'plain');
    const cwd = join(plain, '.claude', 'worktrees', 'xyz');
    expect(projectOf(cwd)).toEqual({ key: pathKey(plain), root: plain, worktree: 'xyz' });
  });

  it('survives a malformed .git file', () => {
    const odd = join(root, 'odd');
    mkdirSync(odd);
    writeFileSync(join(odd, '.git'), '\u0000garbage');
    expect(projectOf(odd)).toEqual({ key: pathKey(odd), root: odd });
  });

  it('falls back to the cwd itself', () => {
    const lone = join(root, 'lone');
    mkdirSync(lone);
    expect(projectOf(lone)).toEqual({ key: pathKey(lone), root: lone });
    expect(basename(projectOf(lone)!.root)).toBe('lone');
  });

  it('returns undefined for empty, relative and UNC paths', () => {
    expect(projectOf('')).toBeUndefined();
    expect(projectOf('relative/dir')).toBeUndefined();
    expect(projectOf('\\\\server\\share\\x')).toBeUndefined();
    expect(projectOf('//server/share/x')).toBeUndefined();
  });
});
