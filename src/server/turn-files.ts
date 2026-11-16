import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePorcelainZ, runGit } from './postcheck.js';
import { dataDir, pathKey } from './paths.js';

/** How a file outside the agent's own edit records was found. */
export type ScanMethod = 'git' | 'mtime';

export interface ScanHit {
  /** Absolute path, expressed under `cwd` as given when the file is inside it. */
  path: string;
  mtimeMs: number;
}

export interface TurnScan {
  method: ScanMethod;
  /** Files modified since the turn start, newest first. */
  hits: ScanHit[];
  /** True when the folder walk ran out of its budget before visiting everything. */
  incomplete: boolean;
}

/**
 * Probe result: the repository root and `git status --porcelain -z` output for cwd; null when cwd
 * is not in a git work tree; 'failed' when it is (a `.git` exists) but git could not report.
 */
export type GitScanProbe = (cwd: string) => Promise<{ root: string; status: string } | null | 'failed'>;

/** Upper bound on files a scan adds to one unit (a code generator could touch hundreds). */
export const MAX_SCAN_FILES = 30;
/** Modification times are compared with this much slack (coarse NTFS / FAT timestamps). */
export const MTIME_SLACK_MS = 1000;
const GIT_TIMEOUT_MS = 2000;
/** The directory walk (folders without git) stops after this many entries or this much time. */
const WALK_MAX_ENTRIES = 20_000;
const WALK_BUDGET_MS = 1000;
const STAT_BATCH = 64;

/** Directories the walk never enters: dependencies, build output, caches, VCS and IDE data. */
export const WALK_SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'obj',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.tox',
  '.gradle',
  '.idea',
  '.vs',
]);

/** File names that likely hold secrets; the scan never snapshots them. */
const SENSITIVE_NAME =
  /^\.env(\..*)?$|\.(pem|key|p12|pfx|jks|keystore)$|credential|^(auth|token|tokens|secret|secrets)\.json$|^id_(rsa|dsa|ecdsa|ed25519)|^\.(npmrc|netrc|pypirc)$/i;

export function isSensitiveName(file: string): boolean {
  return SENSITIVE_NAME.test(path.basename(file));
}

/** Folders whose files are never scanned: the agents' own state and Agent Console's data. */
export function defaultExcludedDirs(): string[] {
  return [
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    dataDir(),
  ];
}

export interface ScanOptions {
  git?: GitScanProbe;
  now?: () => number;
  excludeDirs?: string[];
}

function realOr(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(pathKey(parent), pathKey(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** A folder too broad to walk: the home folder or a filesystem root (results would be noise). */
function tooBroad(dir: string): boolean {
  return pathKey(dir) === pathKey(os.homedir()) || pathKey(dir) === pathKey(path.parse(dir).root);
}

function hasGitDir(dir: string): boolean {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return true;
    if (path.dirname(d) === d) return false;
  }
}

/** git status limited to cwd (`-- .`); porcelain paths stay relative to the repository root. */
export const defaultGitScanProbe: GitScanProbe = async (cwd) => {
  const root = await runGit(['rev-parse', '--show-toplevel'], cwd, GIT_TIMEOUT_MS);
  if (root === null || !root.trim()) return hasGitDir(cwd) ? 'failed' : null;
  const status = await runGit(['status', '--porcelain', '-z', '--untracked-files=all', '--', '.'], cwd, GIT_TIMEOUT_MS);
  return status === null ? 'failed' : { root: root.trim(), status };
};

/** lstat-based: symlinks are never followed (they could point outside the folder). */
async function regularFileMtime(abs: string): Promise<number | null> {
  try {
    const st = await fs.promises.lstat(abs);
    return st.isFile() ? st.mtimeMs : null;
  } catch {
    return null;
  }
}

async function walk(root: string, keep: (abs: string) => boolean, now: () => number): Promise<{ files: string[]; incomplete: boolean }> {
  const deadline = now() + WALK_BUDGET_MS;
  const files: string[] = [];
  const queue = [root];
  let entries = 0;
  while (queue.length > 0) {
    const dir = queue.shift()!;
    let items: fs.Dirent[];
    try {
      items = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of items) {
      if (++entries > WALK_MAX_ENTRIES || now() > deadline) return { files, incomplete: true };
      if (item.isSymbolicLink()) continue;
      const abs = path.join(dir, item.name);
      if (item.isDirectory()) {
        if (!WALK_SKIP_DIRS.has(item.name) && keep(abs)) queue.push(abs);
      } else if (item.isFile() && keep(abs)) {
        files.push(abs);
      }
    }
  }
  return { files, incomplete: false };
}

/**
 * Files modified during a turn that started at `sinceMs`, for edits the agent made outside its own
 * edit tools (shell commands). In a git work tree only paths `git status` reports under cwd
 * (changed or untracked, .gitignore honoured) are considered; elsewhere cwd is walked within a
 * time and entry budget, skipping WALK_SKIP_DIRS. Both rely on modification times, so a file the
 * user or another program changed during the turn is found too. Symlinks, secret-looking names
 * and the agents' own state folders are left out.
 *
 * Returns null when nothing should be scanned: relative, UNC or missing folder; a folder inside an
 * excluded one; a git work tree git could not report on (a walk would ignore .gitignore); or, for
 * the walk, the home folder or a drive root. Never throws.
 */
export async function scanTurnFiles(cwd: string, sinceMs: number, opts: ScanOptions = {}): Promise<TurnScan | null> {
  try {
    if (!cwd || !path.isAbsolute(cwd) || /^[\\/]{2}/.test(cwd)) return null;
    if (!fs.statSync(cwd).isDirectory()) return null;
    const realCwd = realOr(cwd);
    const excluded = (opts.excludeDirs ?? defaultExcludedDirs()).flatMap((d) => [path.resolve(d), realOr(d)]);
    if (excluded.some((d) => isInside(realCwd, d) || isInside(cwd, d))) return null;
    const keep = (abs: string) => !isSensitiveName(abs) && !excluded.some((d) => isInside(abs, d));
    // Report paths under cwd as given (git and realpath give the resolved form of a junction or subst drive).
    const underCwd = (abs: string) => (isInside(abs, realCwd) ? path.join(cwd, path.relative(realCwd, abs)) : abs);

    const git = await (opts.git ?? defaultGitScanProbe)(cwd);
    if (git === 'failed') return null;
    let method: ScanMethod;
    let candidates: string[];
    let incomplete = false;
    if (git) {
      method = 'git';
      candidates = [...parsePorcelainZ(git.status).keys()].map((rel) => path.resolve(git.root, rel)).filter(keep);
    } else {
      if (tooBroad(realCwd)) return null;
      method = 'mtime';
      ({ files: candidates, incomplete } = await walk(realCwd, keep, opts.now ?? Date.now));
    }

    const hits: ScanHit[] = [];
    for (let i = 0; i < candidates.length; i += STAT_BATCH) {
      const batch = candidates.slice(i, i + STAT_BATCH);
      const times = await Promise.all(batch.map(regularFileMtime));
      batch.forEach((abs, j) => {
        const t = times[j];
        if (t !== null && t >= sinceMs - MTIME_SLACK_MS) hits.push({ path: underCwd(abs), mtimeMs: t });
      });
    }
    hits.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
    return { method, hits, incomplete };
  } catch {
    return null;
  }
}
