import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { askTty, readHiddenTty, runLogoutAll, runSetPassword, type Prompter } from '../../src/cli/main.js';
import { readAuthFile } from '../../src/server/remote/password.js';

let home: string;
const prevHome = process.env.AGENT_CONSOLE_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-remote-cli-'));
  process.env.AGENT_CONSOLE_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.AGENT_CONSOLE_HOME;
  else process.env.AGENT_CONSOLE_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

/** Fake prompter: `username` answers ask(); `hidden` answers successive askHidden() calls. */
function fake(username: string, hidden: string[]): Prompter & { defaults: Array<string | undefined> } {
  const defaults: Array<string | undefined> = [];
  const queue = [...hidden];
  return {
    defaults,
    async ask(_q, def) {
      defaults.push(def);
      return username === '' ? (def ?? '') : username;
    },
    async askHidden() {
      return queue.shift() ?? '';
    },
  };
}

const GOOD = 'correct horse battery';

describe('set-password', () => {
  it('writes the auth file, defaulting the username to the OS user', async () => {
    const p = fake('', [GOOD, GOOD]);
    const logs: string[] = [];
    expect(await runSetPassword(p, (s) => logs.push(s))).toBe(true);
    const auth = readAuthFile();
    expect(auth?.username).toBe(os.userInfo().username);
    expect(p.defaults[0]).toBe(os.userInfo().username);
    expect(logs.join('\n')).toContain(`Password saved for ${os.userInfo().username}.`);
    expect(logs.join('\n')).not.toContain('signed out');
  });

  it('uses the typed username and defaults to the existing one next time', async () => {
    await runSetPassword(fake('alice', [GOOD, GOOD]), () => {});
    const p = fake('', [GOOD, GOOD]);
    await runSetPassword(p, () => {});
    expect(p.defaults[0]).toBe('alice');
    expect(readAuthFile()?.username).toBe('alice');
  });

  it('rejects a password shorter than 12 characters', async () => {
    const logs: string[] = [];
    expect(await runSetPassword(fake('alice', ['short', 'short']), (s) => logs.push(s))).toBe(false);
    expect(readAuthFile()).toBeNull();
    expect(logs.join('\n')).toContain('at least 12');
  });

  it('rejects a password longer than 1024 characters with a clear message', async () => {
    const logs: string[] = [];
    const long = 'a'.repeat(1025);
    expect(await runSetPassword(fake('alice', [long, long]), (s) => logs.push(s))).toBe(false);
    expect(readAuthFile()).toBeNull();
    expect(logs.join('\n')).toContain('at most 1024');
  });

  it('rejects mismatched confirmation', async () => {
    const logs: string[] = [];
    expect(await runSetPassword(fake('alice', [GOOD, GOOD + 'x']), (s) => logs.push(s))).toBe(false);
    expect(readAuthFile()).toBeNull();
    expect(logs.join('\n')).toContain('Passwords do not match.');
  });

  it('says existing sign-ins were signed out when changing the password', async () => {
    await runSetPassword(fake('alice', [GOOD, GOOD]), () => {});
    const logs: string[] = [];
    expect(await runSetPassword(fake('alice', [GOOD + '2', GOOD + '2']), (s) => logs.push(s))).toBe(true);
    expect(logs.join('\n')).toContain('Existing remote sign-ins were signed out.');
  });
});

describe('logout-all', () => {
  it('bumps the epoch', async () => {
    await runSetPassword(fake('alice', [GOOD, GOOD]), () => {});
    const before = readAuthFile()!;
    const logs: string[] = [];
    expect(await runLogoutAll((s) => logs.push(s))).toBe(true);
    const after = readAuthFile()!;
    expect(after.sessionEpoch).toBeGreaterThan(before.sessionEpoch);
    expect(after.hash).toBe(before.hash);
    expect(logs.join('\n')).toContain('Signed out all remote sessions.');
  });

  it('without a password explains how to set one', async () => {
    const logs: string[] = [];
    expect(await runLogoutAll((s) => logs.push(s))).toBe(false);
    expect(logs.join('\n')).toContain('agent-console set-password');
  });
});

describe('set-password edge cases', () => {
  it('rejects an empty username', async () => {
    const logs: string[] = [];
    const p: Prompter = { ask: async () => '   ', askHidden: async () => GOOD };
    expect(await runSetPassword(p, (s) => logs.push(s))).toBe(false);
    expect(logs.join('\n')).toContain('Username must not be empty.');
    expect(readAuthFile()).toBeNull();
  });

  it('reports setPassword failures without throwing', async () => {
    const logs: string[] = [];
    // A directory at auth.json makes the atomic write fail.
    fs.mkdirSync(path.join(home, 'auth.json'));
    expect(await runSetPassword(fake('alice', [GOOD, GOOD]), (s) => logs.push(s))).toBe(false);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('\n')).not.toContain('Password saved');
  });
});

describe('readHiddenTty', () => {
  function fakeTty() {
    const stdin = new EventEmitter() as EventEmitter & {
      setRawMode: ReturnType<typeof vi.fn>;
      pause: ReturnType<typeof vi.fn>;
      resume: ReturnType<typeof vi.fn>;
    };
    stdin.setRawMode = vi.fn();
    stdin.pause = vi.fn();
    stdin.resume = vi.fn();
    const written: string[] = [];
    const run = () => readHiddenTty('pw: ', stdin as never, { write: (s) => written.push(s) });
    return { stdin, written, run };
  }

  it('returns the typed text, handling backspace, and never echoes it', async () => {
    const t = fakeTty();
    const p = t.run();
    t.stdin.emit('data', Buffer.from('abc\b\r'));
    expect(await p).toBe('ab');
    expect(t.written.join('')).not.toContain('ab');
    expect(t.stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(t.stdin.pause).toHaveBeenCalled();
  });

  it('rejects on Ctrl+C and restores the terminal', async () => {
    const t = fakeTty();
    const p = t.run();
    t.stdin.emit('data', Buffer.from('ab\x03'));
    await expect(p).rejects.toThrow('Cancelled.');
    expect(t.stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(t.stdin.pause).toHaveBeenCalled();
  });

  it('ignores escape sequences, even split across chunks', async () => {
    const t = fakeTty();
    const p = t.run();
    t.stdin.emit('data', Buffer.from('a\x1b[A\x1b[1;5'));
    t.stdin.emit('data', Buffer.from('Cb\x1bOHc\r'));
    expect(await p).toBe('abc');
  });

  it('decodes a multi-byte character split across chunks', async () => {
    const t = fakeTty();
    const p = t.run();
    const bytes = Buffer.from('é語', 'utf8');
    t.stdin.emit('data', bytes.subarray(0, 1));
    t.stdin.emit('data', bytes.subarray(1, 4));
    t.stdin.emit('data', bytes.subarray(4));
    t.stdin.emit('data', Buffer.from('\r'));
    expect(await p).toBe('é語');
  });
});

describe('readHiddenTty escape handling', () => {
  function run() {
    const stdin = new EventEmitter() as EventEmitter & Record<string, unknown>;
    stdin.setRawMode = vi.fn();
    stdin.pause = vi.fn();
    stdin.resume = vi.fn();
    return { stdin, p: readHiddenTty('pw: ', stdin as never, { write: () => true }) };
  }

  it('Enter ends the line even right after ESC', async () => {
    const t = run();
    t.stdin.emit('data', Buffer.from('\x1b\r'));
    expect(await t.p).toBe('');
  });

  it('Ctrl+C cancels in the middle of a CSI sequence', async () => {
    const t = run();
    t.stdin.emit('data', Buffer.from('ab\x1b[\x03'));
    await expect(t.p).rejects.toThrow('Cancelled.');
  });

  it('treats the character after a lone ESC as normal input', async () => {
    const t = run();
    t.stdin.emit('data', Buffer.from('\x1bx\r'));
    expect(await t.p).toBe('x');
  });
});

describe('askTty', () => {
  function tty() {
    const input = new PassThrough();
    const output = new PassThrough();
    Object.assign(output, { isTTY: true });
    output.resume();
    return { input: Object.assign(input, { isTTY: true }), output };
  }

  it('resolves the typed answer', async () => {
    const t = tty();
    const p = askTty('Username: ', t.input, t.output);
    t.input.write('bob\r');
    expect(await p).toBe('bob');
  });

  it('rejects on Ctrl+C', async () => {
    const t = tty();
    const p = askTty('Username: ', t.input, t.output);
    t.input.write('\x03');
    await expect(p).rejects.toThrow('Cancelled.');
  });

  it('rejects on EOF (Ctrl+D)', async () => {
    const t = tty();
    const p = askTty('Username: ', t.input, t.output);
    t.input.write('\x04');
    await expect(p).rejects.toThrow('Cancelled.');
  });
});
