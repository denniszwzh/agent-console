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
    await expect(setPassword('dennis', 'a'.repeat(11))).rejects.toThrow(/at least 12 characters/);
    expect(readAuthFile()).toBeNull();
    await expect(setPassword('dennis', 'a'.repeat(12))).resolves.toBeTruthy();
  });

  it('increases sessionEpoch when called again', async () => {
    const first = (await setPassword('dennis', PASSWORD)).sessionEpoch;
    expect(first).toBeGreaterThan(0);
    expect((await setPassword('dennis', PASSWORD)).sessionEpoch).toBeGreaterThan(first);
  });

  it('yields a greater epoch after the auth file was deleted', async () => {
    const before = (await setPassword('dennis', PASSWORD)).sessionEpoch;
    fs.rmSync(authFilePath());
    expect((await setPassword('dennis', PASSWORD)).sessionEpoch).toBeGreaterThan(before);
  });

  it('counts the minimum length in code points after NFKC', async () => {
    const smile = String.fromCodePoint(0x1f600);
    await expect(setPassword('dennis', smile.repeat(11))).rejects.toThrow();
    await expect(setPassword('dennis', smile.repeat(12))).resolves.toBeTruthy();
  });

  it('leaves no temporary file behind', async () => {
    await setPassword('dennis', PASSWORD);
    expect(fs.readdirSync(home).filter((f) => f.endsWith('.tmp'))).toEqual([]);
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
    expect(after?.sessionEpoch).toBeGreaterThan(before.sessionEpoch);
    expect(after?.hash).toBe(before.hash);
    expect(readAuthFile()?.sessionEpoch).toBe(after?.sessionEpoch);
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

  it('returns null for invalid field values', async () => {
    const good = await setPassword('dennis', PASSWORD);
    const bad: unknown[] = [
      { ...good, hash: 'zz'.repeat(64) },
      { ...good, hash: good.hash.slice(0, -2) },
      { ...good, sessionEpoch: 0 },
      { ...good, scrypt: { ...good.scrypt, N: 3 } },
      { ...good, scrypt: { ...good.scrypt, N: 2 ** 30 } },
      { ...good, scrypt: { ...good.scrypt, r: 1000 } },
    ];
    for (const b of bad) {
      fs.writeFileSync(authFilePath(), JSON.stringify(b));
      expect(readAuthFile()).toBeNull();
    }
  });
});

describe('verifyCredentials errors', () => {
  it('returns false instead of rejecting on scrypt errors', async () => {
    const good = await setPassword('dennis', PASSWORD);
    const broken = { ...good, scrypt: { ...good.scrypt, N: 3 } };
    expect(await verifyCredentials(broken, 'dennis', PASSWORD)).toBe(false);
  });
});
