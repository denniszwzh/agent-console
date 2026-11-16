import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { callServer } from '../../src/hooks/client.js';
import { promptOutput, runPromptHook } from '../../src/hooks/claude-prompt.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-hooks-'));
  process.env.AGENT_CONSOLE_HOME = dir;
});
afterEach(() => {
  delete process.env.AGENT_CONSOLE_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('callServer', () => {
  it('returns null when server.json is missing', async () => {
    expect(await callServer('GET', '/x')).toBeNull();
  });

  it('returns null when server is down within 2.5s', async () => {
    fs.writeFileSync(path.join(dir, 'token'), 'tok');
    fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ port: 1 }));
    const t0 = Date.now();
    expect(await callServer('POST', '/x', { a: 1 })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2500);
  });
});

describe('hang paths', () => {
  it('callServer returns null when the server accepts but never responds', async () => {
    const sockets: net.Socket[] = [];
    const srv = net.createServer((s) => sockets.push(s));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as net.AddressInfo).port;
    fs.writeFileSync(path.join(dir, 'token'), 'tok');
    fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ port }));
    const t0 = Date.now();
    expect(await callServer('GET', '/x')).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2500);
    sockets.forEach((s) => s.destroy());
    srv.close();
  });

  for (const script of ['claude-stop.js', 'claude-prompt.js']) {
    it(`${script} exits 0 silently when stdin never closes`, async () => {
      const t0 = Date.now();
      const child = spawn('node', [path.resolve('dist/hooks', script)], {
        env: { ...process.env, AGENT_CONSOLE_HOME: dir },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      const code = await new Promise<number | null>((r) => child.on('close', r));
      expect(code).toBe(0);
      expect(out).toBe('');
      expect(Date.now() - t0).toBeLessThan(4000);
    }, 8000);
  }
});

describe('hook scripts', () => {
  const dist = path.resolve('dist/hooks');
  for (const script of ['claude-stop.js', 'claude-prompt.js']) {
    it(`${script} exits 0 silently with AGENT_CONSOLE_FORK=1`, () => {
      const out = execFileSync('node', [path.join(dist, script)], {
        input: '{"session_id":"s","cwd":"."}',
        env: { ...process.env, AGENT_CONSOLE_FORK: '1', AGENT_CONSOLE_HOME: dir },
        encoding: 'utf8',
      });
      expect(out).toBe('');
    });
  }

  it('promptOutput maps actions', () => {
    expect(promptOutput({ action: 'inject', text: 'hi' })).toBe('hi');
    expect(JSON.parse(promptOutput({ action: 'block', reason: 'r' }))).toEqual({ decision: 'block', reason: 'r' });
    expect(promptOutput({ action: 'none' })).toBe('');
    expect(promptOutput(null)).toBe('');
  });
});

describe('runPromptHook two-phase delivery (R-F1)', () => {
  it('writes the injected text first, then acks the unit', async () => {
    const order: string[] = [];
    const calls: [string, string, unknown][] = [];
    const call = async (method: 'GET' | 'POST', url: string, body?: unknown) => {
      calls.push([method, url, body]);
      order.push(`${method} ${url.split('?')[0]}`);
      return method === 'GET' ? { action: 'inject', text: 'BUNDLE', unitId: 'u1' } : { ok: true };
    };
    const write = async (s: string) => {
      order.push(`write ${s}`);
    };
    await runPromptHook('{"session_id":"sess 1"}', call, write);
    expect(order).toEqual(['GET /api/hooks/claude/prompt', 'write BUNDLE', 'POST /api/hooks/claude/prompt/ack']);
    expect(calls[0][1]).toBe('/api/hooks/claude/prompt?session=sess+1');
    expect(calls[1][2]).toEqual({ unitId: 'u1' });
  });

  it('does not ack a block or none answer, nor when the write fails', async () => {
    for (const res of [{ action: 'block', reason: 'r' }, { action: 'none' }]) {
      const posts: string[] = [];
      await runPromptHook('{"session_id":"s"}', async (m, u) => (m === 'POST' ? (posts.push(u), {}) : res), async () => {});
      expect(posts).toEqual([]);
    }
    const posts: string[] = [];
    await runPromptHook(
      '{"session_id":"s"}',
      async (m, u) => (m === 'POST' ? (posts.push(u), {}) : { action: 'inject', text: 'x', unitId: 'u1' }),
      async () => {
        throw new Error('EPIPE');
      },
    ).catch(() => {});
    expect(posts).toEqual([]);
  });
});
