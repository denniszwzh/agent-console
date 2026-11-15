import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Result of one post-check probe: the repository root and raw `git status --porcelain -z` output. */
export interface GitStatus {
  root: string;
  /** NUL-separated porcelain v1 records (paths relative to `root`). */
  status: string;
}

export type GitStatusProbe = (cwd: string) => Promise<GitStatus | null>;
export type StatFn = (absPath: string) => { mtimeMs: number; size: number } | null;

/** Our own git calls must never take index.lock: the user's terminal may be running git at the same time. */
function git(args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
      },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });
}

/** Returns null when cwd is not inside a git work tree (the post-check is then skipped). */
export async function defaultGitStatus(cwd: string): Promise<GitStatus | null> {
  const root = await git(['rev-parse', '--show-toplevel'], cwd);
  if (root === null || !root.trim()) return null;
  const status = await git(['status', '--porcelain', '-z', '--untracked-files=all'], cwd);
  return status === null ? null : { root: root.trim(), status };
}

/**
 * Maps each path in `git status --porcelain -z` output to its status code. With -z paths are
 * never quoted or escaped; a rename/copy record is followed by its source path, which is skipped
 * (the new path is the one reported).
 */
export function parsePorcelainZ(out: string): Map<string, string> {
  const map = new Map<string, string>();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (rec.length < 4) continue;
    const code = rec.slice(0, 2);
    map.set(rec.slice(3), code);
    if (code.includes('R') || code.includes('C')) i++;
  }
  return map;
}

export function defaultStat(absPath: string): { mtimeMs: number; size: number } | null {
  try {
    const st = fs.statSync(absPath);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/** path -> status code + mtime + size, so re-edits of an already-dirty file change the fingerprint. */
export type Fingerprints = Map<string, string>;

export function fingerprint(probe: GitStatus, stat: StatFn): Fingerprints {
  const result: Fingerprints = new Map();
  for (const [p, code] of parsePorcelainZ(probe.status)) {
    const st = stat(path.resolve(probe.root, p));
    result.set(p, st ? `${code}|${st.mtimeMs}|${st.size}` : `${code}|deleted`);
  }
  return result;
}

export function changedPaths(before: Fingerprints, after: Fingerprints): string[] {
  const paths = new Set<string>();
  for (const [p, f] of after) if (before.get(p) !== f) paths.add(p);
  for (const p of before.keys()) if (!after.has(p)) paths.add(p);
  return [...paths].sort();
}
