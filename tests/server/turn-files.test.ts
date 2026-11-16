import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultGitScanProbe, isSensitiveName, scanTurnFiles, type ScanOptions } from '../../src/server/turn-files.js';

let dir: string;
const SINCE = Date.now() - 60_000;
const OLD = SINCE - 3_600_000;
const plain: ScanOptions = { git: async () => null, excludeDirs: [] };

const write = (rel: string, mtimeMs?: number, base = dir) => {
  const abs = path.join(base, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, rel);
  if (mtimeMs !== undefined) fs.utimesSync(abs, mtimeMs / 1000, mtimeMs / 1000);
  return abs;
};
const paths = (r: Awaited<ReturnType<typeof scanTurnFiles>>) => r && [...r.hits.map((h) => h.path)].sort();

beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-scan-')));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('scanTurnFiles without git (modification times)', () => {
  it('finds files modified since the turn start, skipping old files and skipped folders', async () => {
    const fresh = write('notes.md');
    const nested = write(path.join('docs', 'deep', 'plan.md'));
    write('old.md', OLD);
    write(path.join('node_modules', 'pkg', 'index.js'));
    write(path.join('.git', 'HEAD'));
    write(path.join('dist', 'out.js'));
    const r = await scanTurnFiles(dir, SINCE, plain);
    expect(r?.method).toBe('mtime');
    expect(r?.incomplete).toBe(false);
    expect(paths(r)).toEqual([nested, fresh].sort());
  });

  it('lists hits newest first and allows a little slack before the turn start', async () => {
    const a = write('a.txt', SINCE - 500);
    const b = write('b.txt', SINCE + 5000);
    write('c.txt', SINCE - 5000);
    const r = await scanTurnFiles(dir, SINCE, plain);
    expect(r?.hits.map((h) => h.path)).toEqual([b, a]);
  });

  it('never returns secret-looking files or files in excluded folders', async () => {
    for (const f of ['.env', '.env.local', 'server.pem', 'credentials.json', 'auth.json', 'id_ed25519', '.npmrc']) write(f);
    const keep = write('readme.md');
    write(path.join('agent-state', 'session.jsonl'));
    const r = await scanTurnFiles(dir, SINCE, { ...plain, excludeDirs: [path.join(dir, 'agent-state')] });
    expect(paths(r)).toEqual([keep]);
    expect(isSensitiveName('src/env.ts')).toBe(false);
  });

  it('does not scan inside an excluded folder at all', async () => {
    write('history.jsonl');
    write(path.join('x', 'y.txt'));
    expect(await scanTurnFiles(dir, SINCE, { ...plain, excludeDirs: [dir] })).toBeNull();
    expect(await scanTurnFiles(path.join(dir, 'x'), SINCE, { ...plain, excludeDirs: [dir] })).toBeNull();
  });

  it('marks the result incomplete when the time budget is spent', async () => {
    write(path.join('a', 'x.txt'));
    let t = 0;
    // Every clock read moves 2 s, so the budget (1 s) is spent at the first entry.
    const r = await scanTurnFiles(dir, SINCE, { ...plain, now: () => (t += 2000) });
    expect(r).toEqual({ method: 'mtime', hits: [], incomplete: true });
  });

  it('refuses folders it should not walk or cannot scan', async () => {
    expect(await scanTurnFiles(os.homedir(), SINCE, plain)).toBeNull();
    expect(await scanTurnFiles(path.parse(dir).root, SINCE, plain)).toBeNull();
    expect(await scanTurnFiles('relative/dir', SINCE, plain)).toBeNull();
    expect(await scanTurnFiles('\\\\server\\share', SINCE, plain)).toBeNull();
    expect(await scanTurnFiles(path.join(dir, 'missing'), SINCE, plain)).toBeNull();
    expect(await scanTurnFiles(write('file.txt'), SINCE, plain)).toBeNull();
  });

  it('reports paths under the folder as given, also through a junction', async () => {
    const target = path.join(dir, 'real');
    write(path.join('real', 'made.md'));
    const link = path.join(dir, 'link');
    try {
      fs.symlinkSync(target, link, 'junction');
    } catch {
      return; // no junction/symlink support here
    }
    const r = await scanTurnFiles(link, SINCE, plain);
    expect(paths(r)).toEqual([path.join(link, 'made.md')]);
  });
});

describe('scanTurnFiles in a git work tree', () => {
  it('keeps only status paths modified since the turn start, never following symlinks', async () => {
    const changed = write('src/a.ts');
    write('src/b.ts', OLD);
    write('.env');
    const status = ['?? src/a.ts', ' M src/b.ts', ' D src/gone.ts', 'R  src/new.ts', 'src/a.ts', '?? .env', '?? src/link', ''].join('\0');
    try {
      fs.symlinkSync(path.join(dir, 'src', 'a.ts'), path.join(dir, 'src', 'link'), 'file');
    } catch {
      // Symlink creation may need privileges; the entry is then simply missing.
    }
    const r = await scanTurnFiles(dir, SINCE, { excludeDirs: [], git: async () => ({ root: dir.replace(/\\/g, '/'), status }) });
    expect(r).toEqual({ method: 'git', hits: [{ path: changed, mtimeMs: expect.any(Number) }], incomplete: false });
  });

  it('does not fall back to a walk when git cannot report on a work tree', async () => {
    write('notes.md');
    expect(await scanTurnFiles(dir, SINCE, { excludeDirs: [], git: async () => 'failed' })).toBeNull();
  });

  const hasGit = spawnSync('git', ['--version']).status === 0;
  it.skipIf(!hasGit)('probe: a broken .git is reported as failed, a plain folder as no repository', async () => {
    write('plain/x.txt');
    expect(await defaultGitScanProbe(path.join(dir, 'plain'))).toBeNull();
    fs.writeFileSync(path.join(dir, 'plain', '.git'), 'gitdir: ./does-not-exist\n');
    expect(await defaultGitScanProbe(path.join(dir, 'plain'))).toBe('failed');
  });

  it.skipIf(!hasGit)('works against a real repository: limited to the folder, ignored files left out', async () => {
    const run = (...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    run('init', '-q');
    run('config', 'user.email', 't@example.com');
    run('config', 'user.name', 't');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'secret.log\n');
    write(path.join('sub', 'tracked.md'), OLD);
    write('outside.md', OLD);
    run('add', '.');
    run('commit', '-qm', 'init');
    const edited = write(path.join('sub', 'tracked.md'));
    fs.appendFileSync(edited, ' edited');
    const added = write(path.join('sub', 'new.md'));
    fs.appendFileSync(write('outside.md'), ' edited');
    write(path.join('sub', 'secret.log'));
    const r = await scanTurnFiles(path.join(dir, 'sub'), SINCE, { excludeDirs: [] });
    expect(r?.method).toBe('git');
    expect(paths(r)).toEqual([added, edited].sort());
  });
});
