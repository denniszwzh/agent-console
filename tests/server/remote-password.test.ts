import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  authFilePath,
  bumpEpoch,
  readAuthFile,
  setPassword,
  verifyCredentials,
} from '../../src/server/remote/password.js';

let home: string;
const prevHome = process.env.AGENT_CONSOLE_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-console-test-'));
  process.env.AGENT_CONSOLE_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.AGENT_CONSOLE_HOME;
  else process.env.AGENT_CONSOLE_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const PASSWORD = 'correct horse battery';

describe('setPassword', () => {
  it('stores a scrypt hash, never the password', async () => {
    const auth = await setPassword('dennis', PASSWORD);
    const raw = fs.readFileSync(authFilePath(), 'utf8');
    expect(raw).not.toContain(PASSWORD);
    expect(authFilePath()).toBe(path.join(home, 'auth.json'));
    expect(auth.salt).toMatch(/^[0-9a-f]+$/);
    expect(auth.hash).toMatch(/^[0-9a-f]+$/);
    expect(auth.hash).toHaveLength(auth.scrypt.keylen * 2);
    expect(readAuthFile()).toEqual(auth);
  });

  it('rejects passwords shorter than 12 characters', async () => {
    await expect(setPassword('dennis', 'a'.repeat(11))).rejects.toThrow();
    expect(readAuthFile()).toBeNull();
    await expect(setPassword('dennis', 'a'.repeat(12))).resolves.toBeTruthy();
  });

  it('increments sessionEpoch when called again', async () => {
    expect((await setPassword('dennis', PASSWORD)).sessionEpoch).toBe(1);
    expect((await setPassword('dennis', PASSWORD)).sessionEpoch).toBe(2);
  });
});

describe('verifyCredentials', () => {
  it('accepts the right pair and rejects wrong username or password', async () => {
    const auth = await setPassword('dennis', PASSWORD);
    expect(await verifyCredentials(auth, 'dennis', PASSWORD)).toBe(true);
    expect(await verifyCredentials(auth, 'dennis', PASSWORD + 'x')).toBe(false);
    expect(await verifyCredentials(auth, 'other', PASSWORD)).toBe(false);
  });

  it('returns false when no auth file exists', async () => {
    expect(await verifyCredentials(null, 'dennis', PASSWORD)).toBe(false);
  });
});

describe('bumpEpoch', () => {
  it('increments sessionEpoch and keeps the hash', async () => {
    const before = await setPassword('dennis', PASSWORD);
    const after = bumpEpoch();
    expect(after?.sessionEpoch).toBe(before.sessionEpoch + 1);
    expect(after?.hash).toBe(before.hash);
    expect(readAuthFile()?.sessionEpoch).toBe(before.sessionEpoch + 1);
  });

  it('returns null without an auth file', () => {
    expect(bumpEpoch()).toBeNull();
  });
});

describe('readAuthFile', () => {
  it('returns null for an empty or malformed file', () => {
    for (const content of ['', '{', '{"username":1}']) {
      fs.writeFileSync(authFilePath(), content);
      expect(readAuthFile()).toBeNull();
    }
  });
});
