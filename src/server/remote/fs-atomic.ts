import crypto from 'node:crypto';
import fs from 'node:fs';

/** Write via a unique tmp file in the same directory, then rename over the target. */
export function writeFileAtomic(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    // Mode 0o600 has no effect on Windows.
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    // On Windows a reader holding the file open can make rename fail briefly.
    for (let attempt = 1; ; attempt++) {
      try {
        fs.renameSync(tmp, file);
        break;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}
