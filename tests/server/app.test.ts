import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { buildApp } from '../../src/server/app.js';
import { EventBus } from '../../src/server/events.js';
import { UnitStore } from '../../src/server/store.js';
import { ActivityTracker } from '../../src/server/activity.js';
import type { SessionMeta, SessionMetaService } from '../../src/server/session-meta.js';

const TOKEN = 'secret-token';
const PORT = 4317;
const HOST = `127.0.0.1:${PORT}`;
let home: string;
let prev: string | undefined;

beforeEach(() => {
  prev = process.env.AGENT_CONSOLE_HOME;
  home = mkdtempSync(join(tmpdir(), 'ac-app-'));
  process.env.AGENT_CONSOLE_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.AGENT_CONSOLE_HOME;
  else process.env.AGENT_CONSOLE_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

const mk = () => buildApp({ store: new UnitStore(), token: TOKEN, port: PORT });

describe('app auth and host checks', () => {
  it('rejects api without token', async () => {
    const res = await mk().inject({ method: 'GET', url: '/api/sessions', headers: { host: HOST } });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a bearer token and rejects a wrong one', async () => {
    const app = mk();
    const ok = await app.inject({ method: 'GET', url: '/api/sessions', headers: { host: HOST, authorization: `Bearer ${TOKEN}` } });
    expect(ok.statusCode).toBe(200);
    const bad = await app.inject({ method: 'GET', url: '/api/sessions', headers: { host: HOST, authorization: 'Bearer nope' } });
    expect(bad.statusCode).toBe(401);
  });

  it('rejects foreign Host', async () => {
    const res = await mk().inject({ method: 'GET', url: '/api/sessions', headers: { host: 'evil.com', authorization: `Bearer ${TOKEN}` } });
    expect(res.statusCode).toBe(403);
  });

  it('rejects foreign Origin on POST', async () => {
    const res = await mk().inject({
      method: 'POST',
      url: '/api/hooks/claude/stop',
      headers: { host: HOST, origin: 'http://evil.com', authorization: `Bearer ${TOKEN}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('auth sets cookie and cookie authorizes', async () => {
    const app = mk();
    const bad = await app.inject({ method: 'GET', url: '/auth?token=wrong', headers: { host: HOST } });
    expect(bad.statusCode).toBe(401);
    const res = await app.inject({ method: 'GET', url: `/auth?token=${TOKEN}`, headers: { host: HOST } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toContain('ac_token=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    const next = await app.inject({ method: 'GET', url: '/api/sessions', headers: { host: HOST, cookie: `ac_token=${TOKEN}` } });
    expect(next.statusCode).toBe(200);
  });

  it('returns 404 for a missing unit and 500 for a corrupt one', async () => {
    const app = mk();
    const h = { host: HOST, authorization: `Bearer ${TOKEN}` };
    expect((await app.inject({ method: 'GET', url: '/api/units/nope', headers: h })).statusCode).toBe(404);
    mkdirSync(join(home, 'units'), { recursive: true });
    writeFileSync(join(home, 'units', 'bad.json'), '{oops');
    expect((await app.inject({ method: 'GET', url: '/api/units/bad', headers: h })).statusCode).toBe(500);
  });

  it('GET /api/units/..%2Foutside cannot read outside the units directory', async () => {
    const app = mk();
    const h = { host: HOST, authorization: `Bearer ${TOKEN}` };
    writeFileSync(join(home, 'outside.json'), JSON.stringify({ id: 'outside', sessionId: 's' }));
    expect((await app.inject({ method: 'GET', url: '/api/units/..%2Foutside', headers: h })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/units/..%5Coutside', headers: h })).statusCode).toBe(404);
  });

  it('cannot bypass auth with a percent-encoded path', async () => {
    const app = mk();
    const get = await app.inject({ method: 'GET', url: '/%61pi/sessions', headers: { host: HOST } });
    expect(get.statusCode).toBe(401);
    const post = await app.inject({ method: 'POST', url: '/%61pi/hooks/claude/stop', headers: { host: HOST }, payload: {} });
    expect(post.statusCode).toBe(401);
    const unit = await app.inject({ method: 'GET', url: '/%61pi/units/x', headers: { host: HOST } });
    expect(unit.statusCode).toBe(401);
    const ok = await app.inject({ method: 'GET', url: '/%61pi/sessions', headers: { host: HOST, authorization: `Bearer ${TOKEN}` } });
    expect(ok.statusCode).toBe(200);
  });

  it('enforces Host and Origin on /auth and on unknown paths', async () => {
    const app = mk();
    const a = await app.inject({ method: 'GET', url: `/auth?token=${TOKEN}`, headers: { host: 'evil.com' } });
    expect(a.statusCode).toBe(403);
    const b = await app.inject({ method: 'GET', url: `/auth?token=${TOKEN}`, headers: { host: HOST, origin: 'http://evil.com' } });
    expect(b.statusCode).toBe(403);
    const c = await app.inject({ method: 'GET', url: '/nope', headers: { host: 'evil.com' } });
    expect(c.statusCode).toBe(403);
  });

  it('handles Origin variants', async () => {
    const app = mk();
    const h = { host: HOST, authorization: `Bearer ${TOKEN}` };
    expect((await app.inject({ method: 'GET', url: '/api/sessions', headers: { ...h, origin: 'null' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/sessions', headers: { ...h, origin: `http://localhost:${PORT}` } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/sessions', headers: { host: `localhost:${PORT}`, authorization: `Bearer ${TOKEN}` } })).statusCode).toBe(200);
  });

  it('handles cookie edge cases', async () => {
    const app = mk();
    const get = (cookie: string) => app.inject({ method: 'GET', url: '/api/sessions', headers: { host: HOST, cookie } });
    expect((await get('ac_token=wrong')).statusCode).toBe(401);
    expect((await get(`other=1; ac_token=${TOKEN}; x=y`)).statusCode).toBe(200);
    expect((await get('ac_token=%E0%A4%A')).statusCode).toBe(401);
    expect((await get('ac_token')).statusCode).toBe(401);
  });
});

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

describe('SSE', () => {
  it('streams bus events and unsubscribes on disconnect', async () => {
    const port = await freePort();
    const bus = new EventBus();
    const app = buildApp({ store: new UnitStore(), token: TOKEN, port, bus });
    await app.listen({ host: '127.0.0.1', port });
    try {
      const req = http.get({
        host: '127.0.0.1', port, path: '/api/events',
        headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` },
      });
      const res = await new Promise<http.IncomingMessage>((resolve) => req.on('response', resolve));
      expect(res.headers['content-type']).toContain('text/event-stream');
      expect(bus.subscriberCount()).toBe(1);
      const received = new Promise<string>((resolve) => {
        let buf = '';
        res.on('data', (c) => {
          buf += c.toString();
          if (buf.includes('data: ')) resolve(buf);
        });
      });
      bus.emit({ type: 'unit.created', unitId: 'u1', sessionId: 's1' });
      expect(await received).toContain('data: {"type":"unit.created","unitId":"u1","sessionId":"s1"}');
      req.destroy();
      for (let i = 0; i < 50 && bus.subscriberCount() > 0; i++) await new Promise((r) => setTimeout(r, 20));
      expect(bus.subscriberCount()).toBe(0);
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/sessions with transcript meta', () => {
  const headers = { host: HOST, authorization: `Bearer ${TOKEN}` };
  const unit = (id: string, sessionId: string, createdAt: string, transcriptPath?: string) => ({
    id,
    agent: 'claude' as const,
    sessionId,
    cwd: 'C:\work',
    createdAt,
    reply: { id: 'r', kind: 'reply' as const, content: 'hi', blocks: [] },
    files: [],
    threads: [],
    status: 'open' as const,
    delivered: false,
    warnings: [],
    ...(transcriptPath ? { transcriptPath } : {}),
  });
  const fakeMeta = (result: SessionMeta) => {
    const calls: unknown[][] = [];
    const svc = { describe: (...args: unknown[]) => (calls.push(args), result) } as unknown as SessionMetaService;
    return { svc, calls };
  };

  it('merges transcript meta into the session list', async () => {
    const store = new UnitStore();
    store.save(unit('u1', 's1', '2026-11-16T01:00:00.000Z', 'C:\t\s1.jsonl'));
    const meta = { title: '名稱', titleSource: 'agent' as const, createdAt: '2026-11-15T00:00:00.000Z', lastModified: '2026-11-16T00:00:00.000Z' };
    const { svc, calls } = fakeMeta(meta);
    const res = await buildApp({ store, token: TOKEN, port: PORT, sessionMeta: svc }).inject({ method: 'GET', url: '/api/sessions', headers });
    expect(res.json()).toEqual([{ sessionId: 's1', agent: 'claude', cwd: 'C:\work', lastActivity: '2026-11-16T01:00:00.000Z', ...meta }]);
    expect(calls).toEqual([['claude', 's1', 'C:\t\s1.jsonl']]);
  });

  it('lists sessions without transcript meta', async () => {
    const store = new UnitStore();
    store.save(unit('u1', 's1', '2026-11-16T01:00:00.000Z'));
    const res = await buildApp({ store, token: TOKEN, port: PORT, sessionMeta: fakeMeta({}).svc }).inject({ method: 'GET', url: '/api/sessions', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ sessionId: 's1', agent: 'claude', cwd: 'C:\work', lastActivity: '2026-11-16T01:00:00.000Z' }]);
  });

  it('lists a responding session that has no reply yet', async () => {
    const bus = new EventBus();
    const activity = new ActivityTracker(bus);
    try {
      activity.start({ sessionId: 's9', agent: 'codex', cwd: 'C:\w' });
      const { svc, calls } = fakeMeta({});
      const res = await buildApp({ store: new UnitStore(), token: TOKEN, port: PORT, bus, activity, sessionMeta: svc }).inject({
        method: 'GET',
        url: '/api/sessions',
        headers,
      });
      expect(res.json()).toEqual([{ sessionId: 's9', agent: 'codex', cwd: 'C:\w', lastActivity: activity.list()[0].since }]);
      expect(calls).toEqual([['codex', 's9', undefined]]);
    } finally {
      activity.close();
    }
  });

  it('orders sessions by last change, newest first', async () => {
    const store = new UnitStore();
    store.save(unit('u1', 'old-reply', '2026-11-16T01:00:00.000Z'));
    store.save(unit('u2', 'new-reply', '2026-11-16T02:00:00.000Z'));
    const svc = {
      describe: (_a: string, id: string) => (id === 'old-reply' ? { lastModified: '2026-11-16T03:00:00.000Z' } : {}),
    } as unknown as SessionMetaService;
    const res = await buildApp({ store, token: TOKEN, port: PORT, sessionMeta: svc }).inject({ method: 'GET', url: '/api/sessions', headers });
    expect(res.json().map((s: { sessionId: string }) => s.sessionId)).toEqual(['old-reply', 'new-reply']);
  });
});
