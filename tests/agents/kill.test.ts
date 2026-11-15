import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { killTree } from '../../src/agents/kill.js';

describe('killTree', () => {
  it('uses taskkill /T /F on Windows', () => {
    const exec = vi.fn();
    const child = { pid: 1234, kill: vi.fn() } as unknown as ChildProcess;
    killTree(child, 'win32', exec);
    expect(exec).toHaveBeenCalledWith('taskkill', ['/T', '/F', '/PID', '1234'], expect.objectContaining({ windowsHide: true }), expect.any(Function));
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('falls back to child.kill() when taskkill cannot be started', () => {
    const child = { pid: 1234, kill: vi.fn() } as unknown as ChildProcess;
    killTree(child, 'win32', () => {
      throw new Error('ENOENT');
    });
    expect(child.kill).toHaveBeenCalled();
  });

  it('uses child.kill() elsewhere and when there is no pid', () => {
    const exec = vi.fn();
    const a = { pid: 1, kill: vi.fn() } as unknown as ChildProcess;
    killTree(a, 'linux', exec);
    expect(a.kill).toHaveBeenCalled();
    const b = { pid: undefined, kill: vi.fn() } as unknown as ChildProcess;
    killTree(b, 'win32', exec);
    expect(b.kill).toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  describe.runIf(process.platform === 'win32')('on a real process tree', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-kill-'));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('also kills grandchildren', async () => {
      const script = path.join(dir, 'parent.mjs');
      fs.writeFileSync(
        script,
        `import { spawn } from 'node:child_process';
         const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
         console.log(g.pid);
         setInterval(() => {}, 1000);`,
      );
      const parent = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      const gpid = await new Promise<number>((resolve) => parent.stdout!.once('data', (d) => resolve(Number(String(d).trim()))));
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      expect(alive(gpid)).toBe(true);
      killTree(parent);
      for (let i = 0; i < 50 && alive(gpid); i++) await new Promise((r) => setTimeout(r, 100));
      expect(alive(gpid)).toBe(false);
    }, 10_000);
  });
});
