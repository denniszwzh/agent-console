import fs from 'node:fs';
import path from 'node:path';
import { pathKey } from './paths.js';

export interface ProjectInfo {
  /** Same-folder key (case-insensitive on Windows), for grouping. */
  key: string;
  /** The project's root folder: the main repository for a git worktree. */
  root: string;
  /** Name of the worktree the session ran in, if any. */
  worktree?: string;
}

/** Claude Code desktop's worktree folders: <repo>/.claude/worktrees/<name>. */
const WORKTREE_PATH = /[\\/]\.claude[\\/]worktrees[\\/]([^\\/]+)/;
/** gitdir of a linked worktree: <repo>/.git/worktrees/<name>. */
const GITDIR_WORKTREE = /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/;

const cache = new Map<string, ProjectInfo | undefined>();

function info(root: string, worktree?: string): ProjectInfo {
  return worktree ? { key: pathKey(root), root, worktree } : { key: pathKey(root), root };
}

function statKind(p: string): 'dir' | 'file' | null {
  try {
    const st = fs.statSync(p);
    return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null;
  } catch {
    return null;
  }
}

/** Main repository of a linked worktree, from its `.git` file; undefined when the file is not one. */
function mainRepoOf(gitFile: string): string | undefined {
  try {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(gitFile, 'utf8'));
    if (!m) return undefined;
    const gitdir = path.resolve(path.dirname(gitFile), m[1]);
    return GITDIR_WORKTREE.exec(gitdir)?.[1];
  } catch {
    return undefined;
  }
}

function resolveProject(cwd: string): ProjectInfo | undefined {
  // UNC paths could block on the network; relative paths have no place to start from.
  if (!cwd || cwd.startsWith('\\\\') || cwd.startsWith('//') || !path.isAbsolute(cwd)) return undefined;
  const start = path.resolve(cwd);
  for (let dir = start; ; ) {
    const git = path.join(dir, '.git');
    const kind = statKind(git);
    if (kind === 'file') {
      const main = mainRepoOf(git);
      if (main) return info(main, path.basename(dir));
    } else if (kind === 'dir') {
      // A deleted Claude worktree still sits under the repository it came from.
      const below = path.relative(dir, start);
      const deleted = WORKTREE_PATH.exec(`${path.sep}${below}`);
      return info(dir, deleted && deleted.index === 0 ? deleted[1] : undefined);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const m = WORKTREE_PATH.exec(cwd);
  if (m) return info(cwd.slice(0, m.index), m[1]);
  return info(cwd);
}

/** The project (and worktree) a session's folder belongs to; cached per folder. Never throws. */
export function projectOf(cwd: string): ProjectInfo | undefined {
  const k = pathKey(cwd || '.');
  if (cache.has(k)) return cache.get(k);
  let result: ProjectInfo | undefined;
  try {
    result = resolveProject(cwd);
  } catch {
    result = undefined;
  }
  cache.set(k, result);
  return result;
}
