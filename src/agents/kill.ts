import { execFile, type ChildProcess } from 'node:child_process';

type Exec = (file: string, args: string[], opts: { windowsHide: boolean }, cb: () => void) => unknown;

/**
 * Kills a CLI child together with everything it started. On Windows `child.kill()` only ends the
 * top process (the CLI's own tool shells would linger), so the whole tree goes via taskkill.
 * Failures are ignored: the process may already be gone.
 */
export function killTree(child: ChildProcess, platform: NodeJS.Platform = process.platform, exec: Exec = execFile): void {
  if (platform === 'win32' && child.pid !== undefined) {
    try {
      exec('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true }, () => {});
      return;
    } catch {
      // Fall through to a plain kill.
    }
  }
  try {
    child.kill();
  } catch {
    // Already gone.
  }
}
