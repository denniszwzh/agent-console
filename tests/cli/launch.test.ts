import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { launch } from '../../src/cli/main.js';
import { buildApp } from '../../src/server/app.js';
import { ensureToken, writeServerInfo } from '../../src/server/paths.js';
import { UnitStore } from '../../src/server/store.js';

let home: string;
let prev: string | undefined;
beforeEach(() => {
  prev = process.env.AGENT_CONSOLE_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-launch-'));
  process.env.AGENT_CONSOLE_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.AGENT_CONSOLE_HOME;
  else process.env.AGENT_CONSOLE_HOME = prev;
  fs.rmSync(home, { recursive: true, force: true });
});

const inUse = () => Promise.reject(Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:4317'), { code: 'EADDRINUSE' }));

function deps(over: Partial<Parameters<typeof launch>[0]> = {}) {
  return {
    start: vi.fn(async () => {}),
    probe: vi.fn(async () => false),
    openBrowser: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
    ...over,
  };
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });

describe('launch (final review item 12)', () => {
  it('starts the server and opens the browser', async () => {
    const d = deps();
    expect(await launch(d)).toBeNull();
    expect(d.openBrowser).toHaveBeenCalledWith(expect.stringMatching(/^http:\/\/127\.0\.0\.1:4317\/auth\?token=/));
  });

  it('port in use by a live Agent Console: opens the browser on it and exits 0', async () => {
    writeServerInfo(4400);
    const d = deps({ start: vi.fn(inUse), probe: vi.fn(async () => true) });
    expect(await launch(d)).toBe(0);
    expect(d.openBrowser).toHaveBeenCalledWith(`http://127.0.0.1:4400/auth?token=${ensureToken()}`);
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('already running'));
  });

  it('port in use by something else: prints a clear EADDRINUSE message and exits 1', async () => {
    const d = deps({ start: vi.fn(inUse) });
    expect(await launch(d)).toBe(1);
    expect(d.openBrowser).not.toHaveBeenCalled();
    const msg = d.error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(msg).toContain('EADDRINUSE');
    expect(msg).toContain('4317');
    expect(msg).toContain('config.json');
  });

  it('rethrows other start errors', async () => {
    await expect(launch(deps({ start: vi.fn(async () => Promise.reject(new Error('boom'))) }))).rejects.toThrow('boom');
  });

  it('the default probe recognises a real running Agent Console via server.json and the token', async () => {
    const port = await freePort();
    const token = ensureToken();
    const app = buildApp({ store: new UnitStore(), token, port });
    await app.listen({ host: '127.0.0.1', port });
    try {
      writeServerInfo(port);
      const d = deps({ start: vi.fn(inUse) });
      delete (d as Partial<typeof d>).probe;
      expect(await launch(d)).toBe(0);
      expect(d.openBrowser).toHaveBeenCalledWith(`http://127.0.0.1:${port}/auth?token=${token}`);
    } finally {
      await app.close();
    }
  });
});
