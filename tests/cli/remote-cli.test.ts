import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runLogoutAll, runSetPassword, type Prompter } from '../../src/cli/main.js';
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
