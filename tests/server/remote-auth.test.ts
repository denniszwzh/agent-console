import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RemoteAuth } from '../../src/server/remote/auth.js';
import { authFilePath, bumpEpoch, setPassword } from '../../src/server/remote/password.js';

let home: string;
let auth: RemoteAuth | null = null;
const prevHome = process.env.AGENT_CONSOLE_HOME;
const PASSWORD = 'correct horse battery';
const IP = '10.0.0.1';

const make = () => (auth = new RemoteAuth({ sessionDays: 30, pollMs: 50, failureDelayMs: 0 }));

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-console-test-'));
  process.env.AGENT_CONSOLE_HOME = home;
  await setPassword('admin', PASSWORD);
});

afterEach(() => {
  auth?.close();
  auth = null;
  if (prevHome === undefined) delete process.env.AGENT_CONSOLE_HOME;
  else process.env.AGENT_CONSOLE_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function login(a: RemoteAuth, pw = PASSWORD, ip = IP) {
  return a.login('admin', pw, { ip, userAgent: 'vitest' });
}

describe('RemoteAuth', () => {
  it('login succeeds with the right credentials and check accepts the returned id', async () => {
    const a = make();
    expect(a.hasPassword()).toBe(true);
    const r = await login(a);
    if (!r.ok) throw new Error('expected ok');
    expect(r.username).toBe('admin');
    expect(a.check(r.id).ok).toBe(true);
    expect(a.check(null)).toEqual({ ok: false });
    expect(a.check('0'.repeat(64))).toEqual({ ok: false });
  });

  it('login fails with wrong credentials and locks after 5 failures', async () => {
    const a = make();
    for (let i = 0; i < 5; i++) expect(await login(a, 'wrong password!!')).toEqual({ ok: false, reason: 'invalid' });
    expect(await login(a)).toMatchObject({ ok: false, reason: 'locked' });
    expect((await login(a, PASSWORD, '10.0.0.2')).ok).toBe(true);
  });

  it('serialises concurrent attempts from one ip so the lock cannot be outrun', async () => {
    const a = make();
    const results = await Promise.all(Array.from({ length: 8 }, () => login(a, 'wrong password!!')));
    const invalid = results.filter((r) => !r.ok && r.reason === 'invalid').length;
    const locked = results.filter((r) => !r.ok && r.reason === 'locked').length;
    expect(invalid).toBe(5);
    expect(locked).toBe(3);
  });

  it("a successful login clears the ip's failures", async () => {
    const a = make();
    for (let i = 0; i < 4; i++) await login(a, 'wrong password!!');
    expect((await login(a)).ok).toBe(true);
    for (let i = 0; i < 4; i++) expect(await login(a, 'wrong password!!')).toEqual({ ok: false, reason: 'invalid' });
    expect((await login(a)).ok).toBe(true);
  });

  it('login fails when no password is set', async () => {
    fs.rmSync(authFilePath());
    const a = make();
    expect(a.hasPassword()).toBe(false);
    expect(await login(a)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('logout revokes only that session and notifies its key', async () => {
    const a = make();
    const r1 = await login(a);
    const r2 = await login(a);
    if (!r1.ok || !r2.ok) throw new Error('expected ok');
    const seen: Array<'all' | string[]> = [];
    a.onRevoke((k) => seen.push(k));
    const key = a.logout(r1.id);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(seen).toEqual([[key]]);
    expect(a.check(r1.id)).toEqual({ ok: false });
    expect(a.check(r2.id).ok).toBe(true);
  });

  it("bumpEpoch from another process revokes all sessions and notifies 'all' within pollMs", async () => {
    const a = make();
    const r = await login(a);
    if (!r.ok) throw new Error('expected ok');
    const listener = vi.fn();
    a.onRevoke(listener);
    bumpEpoch();
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith('all'), { timeout: 2000 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(a.check(r.id)).toEqual({ ok: false });
  });

  it('setPassword from another process revokes all sessions', async () => {
    const a = make();
    const r = await login(a);
    if (!r.ok) throw new Error('expected ok');
    const listener = vi.fn();
    a.onRevoke(listener);
    await setPassword('admin', 'another long password');
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith('all'), { timeout: 2000 });
    expect(a.check(r.id)).toEqual({ ok: false });
  });

  it('honours an epoch change on the next check even before the watcher fires', async () => {
    const a = new RemoteAuth({ sessionDays: 30, pollMs: 60_000, failureDelayMs: 0 });
    auth = a;
    const r = await login(a);
    if (!r.ok) throw new Error('expected ok');
    bumpEpoch();
    expect(a.check(r.id)).toEqual({ ok: false });
  });

  it("emits 'all' once and fails checks when auth.json disappears", async () => {
    const a = make();
    const r = await login(a);
    if (!r.ok) throw new Error('expected ok');
    const listener = vi.fn();
    a.onRevoke(listener);
    fs.rmSync(authFilePath());
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith('all'), { timeout: 2000 });
    await new Promise((res) => setTimeout(res, 150));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(a.hasPassword()).toBe(false);
    expect(a.check(r.id)).toEqual({ ok: false });
  });

  it('logout of an unknown id returns null and notifies nothing', () => {
    const a = make();
    const listener = vi.fn();
    a.onRevoke(listener);
    expect(a.logout('a'.repeat(64))).toBeNull();
    expect(a.logout('not-an-id')).toBeNull();
    expect(listener).not.toHaveBeenCalled();
  });

  it('recovers when a read of an existing auth.json fails transiently', async () => {
    const a = make();
    bumpEpoch(); // new stamp, so the next call must re-read the file
    const real = fs.readFileSync;
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    });
    expect(a.hasPassword()).toBe(false);
    spy.mockRestore();
    expect(fs.readFileSync).toBe(real);
    expect(a.hasPassword()).toBe(true);
    expect((await login(a)).ok).toBe(true);
  });

  it("a malformed auth.json emits 'all' once and fails closed", async () => {
    const a = make();
    const listener = vi.fn();
    a.onRevoke(listener);
    fs.writeFileSync(authFilePath(), '{ not json');
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith('all'), { timeout: 2000 });
    await new Promise((res) => setTimeout(res, 200));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(a.hasPassword()).toBe(false);
  });

  it('waits failureDelayMs after a failure, counted before the sleep; locked does not wait', async () => {
    const a = new RemoteAuth({ sessionDays: 30, pollMs: 60_000, failureDelayMs: 300 });
    auth = a;
    const t0 = Date.now();
    const first = login(a, 'wrong password!!');
    let settled = false;
    void first.then(() => { settled = true; });
    // Burn the other 4 failures in parallel; they queue behind the first.
    const rest = Array.from({ length: 4 }, () => login(a, 'wrong password!!'));
    await first;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
    expect(settled).toBe(true);
    await Promise.all(rest);
    const t1 = Date.now();
    expect(await login(a)).toMatchObject({ ok: false, reason: 'locked' });
    expect(Date.now() - t1).toBeLessThan(250);
  });

  it('close stops the poll and the watcher', async () => {
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const a = make();
    const listener = vi.fn();
    a.onRevoke(listener);
    a.close();
    expect(clear).toHaveBeenCalledTimes(1);
    clear.mockRestore();
    bumpEpoch();
    await new Promise((res) => setTimeout(res, 200));
    expect(listener).not.toHaveBeenCalled();
  });
});
