import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';
import { EventBus } from '../../src/server/events.js';
import { UnitStore } from '../../src/server/store.js';
import { ThreadEngine } from '../../src/server/threads.js';
import { ActivityTracker } from '../../src/server/activity.js';
import { RemoteAuth } from '../../src/server/remote/auth.js';
import type { RemoteConfig } from '../../src/server/remote/config.js';
import { bumpEpoch, setPassword } from '../../src/server/remote/password.js';

const PORT = 4318;
const HOST = `ws1.corp:${PORT}`;
const USER = 'admin';
const PASSWORD = 'correct horse battery';
const COOKIE = '__Host-ac_session';
const DAY_MS = 86_400_000;
const POLL_MS = 50;

let home: string;
let prev: string | undefined;
let auth: RemoteAuth | null = null;
let app: FastifyInstance | null = null;
let clock = Date.now();

beforeEach(async () => {
  prev = process.env.AGENT_CONSOLE_HOME;
  home = mkdtempSync(join(tmpdir(), 'ac-remote-app-'));
  process.env.AGENT_CONSOLE_HOME = home;
  clock = Date.now();
  await setPassword(USER, PASSWORD);
});

afterEach(async () => {
  await app?.close();
  app = null;
  auth?.close();
  auth = null;
  if (prev === undefined) delete process.env.AGENT_CONSOLE_HOME;
  else process.env.AGENT_CONSOLE_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

function config(port = PORT): RemoteConfig {
  return { port, bindHost: '0.0.0.0', hostnames: ['ws1.corp'], sessionDays: 30 };
}

function mk(opts: { heartbeatMs?: number; port?: number; engine?: ThreadEngine; activity?: ActivityTracker; bus?: EventBus } = {}): {
  app: FastifyInstance;
  bus: EventBus;
  auth: RemoteAuth;
  routes: { method: string; url: string }[];
} {
  const store = new UnitStore();
  const bus = opts.bus ?? new EventBus();
  const engine = opts.engine ?? new ThreadEngine(store, bus, {}, 1, { gitStatus: async () => null });
  auth = new RemoteAuth({ sessionDays: 30, now: () => clock, pollMs: POLL_MS, failureDelayMs: 0 });
  app = buildApp({
    store,
    token: 'secret',
    port: 4317,
    bus,
    engine,
    config: { port: 4317, concurrency: 1, hardGate: true, runTimeoutMs: 600_000 },
    codexQueue: async () => false,
    webRoot: join(home, 'no-web'),
    activity: opts.activity,
    heartbeatMs: opts.heartbeatMs,
    remote: { config: config(opts.port), auth },
  });
  const routes: { method: string; url: string }[] = [];
  app.addHook('onRoute', (r) => {
    for (const m of [r.method].flat()) routes.push({ method: m, url: r.url });
  });
  return { app, bus, auth, routes };
}

async function login(a: FastifyInstance, password = PASSWORD, host = HOST) {
  return a.inject({ method: 'POST', url: '/auth/login', headers: { host }, payload: { username: USER, password } });
}

function sessionIdFrom(res: { headers: Record<string, unknown> }): string {
  const header = [res.headers['set-cookie']].flat().map(String).find((c) => c.startsWith(`${COOKIE}=`));
  if (!header) throw new Error('no session cookie');
  return header.slice(COOKIE.length + 1).split(';')[0];
}

async function signIn(a: FastifyInstance): Promise<string> {
  const res = await login(a);
  expect(res.statusCode).toBe(204);
  return sessionIdFrom(res);
}

const withSession = (id: string, extra: Record<string, string> = {}) => ({ host: HOST, cookie: `${COOKIE}=${id}`, ...extra });

describe('remote entry: route protection', () => {
  it('every /api route answers 401 without a session', async () => {
    const { app: a, routes } = mk();
    await a.ready();
    const api = routes.filter((r) => r.url.startsWith('/api/') && r.method !== 'HEAD');
    // Sanity: the enumeration saw the event stream and the unit/thread routes, but no hook route.
    expect(api.map((r) => `${r.method} ${r.url}`)).toEqual(
      expect.arrayContaining(['GET /api/events', 'GET /api/sessions', 'POST /api/units/:id/integrate', 'POST /api/threads/:id/send']),
    );
    expect(api.filter((r) => r.url.startsWith('/api/hooks/'))).toEqual([]);
    const leaks: string[] = [];
    for (const r of api) {
      const url = r.url.replace(/:[A-Za-z]+/g, 'x');
      const res = await a.inject({ method: r.method as 'GET', url, headers: { host: HOST }, payload: r.method === 'GET' ? undefined : {} });
      if (res.statusCode !== 401) leaks.push(`${r.method} ${r.url} -> ${res.statusCode}`);
    }
    expect(leaks).toEqual([]);
  });

  it('hook routes and token sign-in are not served', async () => {
    const { app: a } = mk();
    const id = await signIn(a);
    for (const h of [{ host: HOST }, withSession(id)]) {
      expect((await a.inject({ method: 'POST', url: '/api/hooks/claude/stop', headers: h, payload: {} })).statusCode).toBe(404);
      expect((await a.inject({ method: 'GET', url: '/api/hooks/claude/prompt', headers: h })).statusCode).toBe(404);
      expect((await a.inject({ method: 'GET', url: '/auth?token=secret', headers: h })).statusCode).toBe(404);
    }
  });

  it('bearer token and ac_token cookie are not accepted', async () => {
    const { app: a } = mk();
    const bearer = await a.inject({ method: 'GET', url: '/api/sessions', headers: { host: HOST, authorization: 'Bearer secret' } });
    expect(bearer.statusCode).toBe(401);
    const cookie = await a.inject({ method: 'GET', url: '/api/sessions', headers: { host: HOST, cookie: 'ac_token=secret' } });
    expect(cookie.statusCode).toBe(401);
  });

  it('malformed session cookies fail authentication without throwing', async () => {
    const { app: a } = mk();
    for (const value of ['', 'abc', '%E0%A4%A', 'g'.repeat(64), '0'.repeat(64), 'A'.repeat(64), '0'.repeat(65)]) {
      const res = await a.inject({ method: 'GET', url: '/api/sessions', headers: { host: HOST, cookie: `${COOKIE}=${value}` } });
      expect(res.statusCode, value).toBe(401);
      const mode = await a.inject({ method: 'GET', url: '/auth/mode', headers: { host: HOST, cookie: `${COOKIE}=${value}` } });
      expect(mode.json(), value).toEqual({ mode: 'password', signedIn: false });
    }
  });

  it('rejects a foreign host or origin with 403', async () => {
    const { app: a } = mk();
    const local = await a.inject({ method: 'GET', url: '/auth/mode', headers: { host: '127.0.0.1:4318' } });
    expect(local.statusCode).toBe(403);
    const evil = await a.inject({ method: 'POST', url: '/auth/login', headers: { host: HOST, origin: 'https://evil.example' }, payload: { username: USER, password: PASSWORD } });
    expect(evil.statusCode).toBe(403);
    const plainHttp = await a.inject({ method: 'GET', url: '/auth/mode', headers: { host: HOST, origin: 'http://ws1.corp:4318' } });
    expect(plainHttp.statusCode).toBe(403);
    const ok = await a.inject({ method: 'GET', url: '/auth/mode', headers: { host: HOST, origin: 'https://ws1.corp:4318' } });
    expect(ok.statusCode).toBe(200);

    // A valid session does not get past a foreign Origin either.
    const id = await signIn(a);
    const evilApi = await a.inject({ method: 'GET', url: '/api/sessions', headers: withSession(id, { origin: 'https://evil.example' }) });
    expect(evilApi.statusCode).toBe(403);
    const evilLogout = await a.inject({ method: 'POST', url: '/auth/logout', headers: withSession(id, { origin: 'https://evil.example' }) });
    expect(evilLogout.statusCode).toBe(403);
    expect(evilLogout.headers['set-cookie']).toBeUndefined();
    // ...so the session is still signed in.
    expect((await a.inject({ method: 'GET', url: '/api/sessions', headers: withSession(id, { origin: 'https://ws1.corp:4318' }) })).statusCode).toBe(200);
  });

  it('leaves the shared submitter and activity tracker to the local entry', async () => {
    const store = new UnitStore();
    const bus = new EventBus();
    const engine = new ThreadEngine(store, bus, {}, 1, { gitStatus: async () => null });
    const activity = new ActivityTracker(bus);
    const setSubmitter = vi.spyOn(engine, 'setSubmitter');
    const closeActivity = vi.spyOn(activity, 'close');
    const { app: a } = mk({ engine, activity, bus });
    await a.ready();
    await a.close();
    app = null;
    expect(setSubmitter).not.toHaveBeenCalled();
    expect(closeActivity).not.toHaveBeenCalled();
  });

  it('closes an activity tracker it created itself', async () => {
    const closeActivity = vi.spyOn(ActivityTracker.prototype, 'close');
    try {
      const { app: a } = mk();
      await a.ready();
      await a.close();
      app = null;
      expect(closeActivity).toHaveBeenCalledTimes(1);
    } finally {
      closeActivity.mockRestore();
    }
  });

  it('accepts host without port when remote port is 443', async () => {
    const { app: a } = mk({ port: 443 });
    for (const host of ['ws1.corp', 'ws1.corp:443']) {
      const res = await a.inject({ method: 'GET', url: '/auth/mode', headers: { host, origin: 'https://ws1.corp' } });
      expect(res.statusCode, host).toBe(200);
    }
    const withPort = await a.inject({ method: 'GET', url: '/auth/mode', headers: { host: 'ws1.corp', origin: 'https://ws1.corp:443' } });
    expect(withPort.statusCode).toBe(200);
    expect((await login(a, PASSWORD, 'ws1.corp')).statusCode).toBe(204);
  });
});

describe('remote entry: sign-in', () => {
  it('login sets a __Host- cookie with the required attributes', async () => {
    const { app: a } = mk();
    const res = await login(a);
    expect(res.statusCode).toBe(204);
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/^__Host-ac_session=[0-9a-f]{64};/);
    for (const attr of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=2592000']) {
      expect(setCookie.split('; ')).toContain(attr);
    }
    const id = sessionIdFrom(res);
    const next = await a.inject({ method: 'GET', url: '/api/sessions', headers: withSession(id) });
    expect(next.statusCode).toBe(200);
    expect(next.headers['set-cookie']).toBeUndefined();
  });

  it('auth/mode reports signed-in state and username', async () => {
    const { app: a } = mk();
    const before = await a.inject({ method: 'GET', url: '/auth/mode', headers: { host: HOST } });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual({ mode: 'password', signedIn: false });
    const id = await signIn(a);
    const after = await a.inject({ method: 'GET', url: '/auth/mode', headers: withSession(id) });
    expect(after.json()).toEqual({ mode: 'password', signedIn: true, username: USER });
  });

  it('wrong password answers 401 and the 6th attempt 429 with retryAfterSec', async () => {
    const { app: a } = mk();
    for (let i = 0; i < 5; i++) {
      const res = await login(a, 'wrong password!!');
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Wrong username or password' });
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    const locked = await login(a);
    expect(locked.statusCode).toBe(429);
    const body = locked.json() as { error: string; retryAfterSec: number };
    expect(body.retryAfterSec).toBeGreaterThan(14 * 60);
    expect(body.retryAfterSec).toBeLessThanOrEqual(15 * 60);
    expect(body.error).toBe('Too many failed sign-ins. Try again in 15 minutes.');
    expect(locked.headers['retry-after']).toBe(String(body.retryAfterSec));
    expect(locked.headers['set-cookie']).toBeUndefined();

    // Under a minute left: singular.
    clock += 14 * 60_000 + 30_000;
    const last = await login(a);
    expect(last.statusCode).toBe(429);
    expect(last.json()).toEqual({ error: 'Too many failed sign-ins. Try again in 1 minute.', retryAfterSec: 30 });
  });

  it('a wrong username answers the same 401 as a wrong password', async () => {
    const { app: a } = mk();
    const res = await a.inject({ method: 'POST', url: '/auth/login', headers: { host: HOST }, payload: { username: 'root', password: PASSWORD } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Wrong username or password' });
  });

  it('malformed login bodies answer 400', async () => {
    const { app: a } = mk();
    const post = (payload: unknown, contentType: string | null = 'application/json') =>
      a.inject({
        method: 'POST',
        url: '/auth/login',
        headers: contentType === null ? { host: HOST } : { host: HOST, 'content-type': contentType },
        payload: payload as string,
      });
    const cases: [unknown, string | null][] = [
      [{}, 'application/json'],
      [{ username: 1, password: 'x' }, 'application/json'],
      [{ username: USER }, 'application/json'],
      [[USER, PASSWORD], 'application/json'],
      ['null', 'application/json'],
      ['not json', 'application/json'],
      ['', 'application/json'],
      ['username=admin&password=x', 'text/plain'],
      [`username=${USER}&password=x`, 'application/x-www-form-urlencoded'],
      ['--b\r\nContent-Disposition: form-data; name="username"\r\n\r\nadmin\r\n--b--', 'multipart/form-data; boundary=b'],
      ['{"username":"admin","password":"x"}', null],
    ];
    for (const [payload, contentType] of cases) {
      const res = await post(payload, contentType);
      expect(res.statusCode, `${contentType}: ${JSON.stringify(payload)}`).toBe(400);
      expect(res.json()).toEqual({ error: 'Invalid request' });
    }
    // None of these count as failed sign-ins.
    expect((await login(a)).statusCode).toBe(204);
  });

  it('oversized credentials answer 400 and do not count as failures', async () => {
    const { app: a } = mk();
    const post = (username: string, password: string) =>
      a.inject({ method: 'POST', url: '/auth/login', headers: { host: HOST }, payload: { username, password } });
    for (let i = 0; i < 6; i++) {
      for (const [u, p] of [['u'.repeat(257), PASSWORD], [USER, 'p'.repeat(1025)]]) {
        const res = await post(u, p);
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: 'Invalid request' });
      }
    }
    // Twelve oversized attempts did not lock the address.
    expect((await login(a)).statusCode).toBe(204);
  });

  it('logout invalidates the cookie', async () => {
    const { app: a } = mk();
    const id = await signIn(a);
    const out = await a.inject({ method: 'POST', url: '/auth/logout', headers: withSession(id) });
    expect(out.statusCode).toBe(204);
    const cleared = String(out.headers['set-cookie']);
    expect(cleared).toMatch(/^__Host-ac_session=;/);
    expect(cleared.split('; ')).toEqual(expect.arrayContaining(['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0']));
    expect((await a.inject({ method: 'GET', url: '/api/sessions', headers: withSession(id) })).statusCode).toBe(401);
    const mode = await a.inject({ method: 'GET', url: '/auth/mode', headers: withSession(id) });
    expect(mode.json()).toEqual({ mode: 'password', signedIn: false });
  });

  it('logout without a cookie answers 204', async () => {
    const { app: a } = mk();
    const res = await a.inject({ method: 'POST', url: '/auth/logout', headers: { host: HOST } });
    expect(res.statusCode).toBe(204);
    expect(String(res.headers['set-cookie'])).toContain('Max-Age=0');
    const junk = await a.inject({ method: 'POST', url: '/auth/logout', headers: { host: HOST, cookie: `${COOKIE}=nope` } });
    expect(junk.statusCode).toBe(204);
  });

  it('re-issues the cookie when the session needs refresh', async () => {
    const { app: a } = mk();
    const id = await signIn(a);
    clock += DAY_MS + 60_000;
    const res = await a.inject({ method: 'GET', url: '/api/sessions', headers: withSession(id) });
    expect(res.statusCode).toBe(200);
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie.startsWith(`${COOKIE}=${id};`)).toBe(true);
    expect(setCookie.split('; ')).toEqual(expect.arrayContaining(['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=2592000']));
    // Only once per day.
    const again = await a.inject({ method: 'GET', url: '/api/sessions', headers: withSession(id) });
    expect(again.headers['set-cookie']).toBeUndefined();
  });
});

interface Stream {
  data: string;
  headers: http.IncomingHttpHeaders;
  ended: Promise<void>;
  isEnded: () => boolean;
  req: http.ClientRequest;
}

function openStream(port: number, id: string): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: withSession(id) }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`status ${res.statusCode}`));
      res.setEncoding('utf8');
      let ended = false;
      const stream: Stream = {
        data: '',
        headers: res.headers,
        ended: new Promise((r) => res.on('end', () => { ended = true; r(); })),
        isEnded: () => ended,
        req,
      };
      res.on('data', (chunk: string) => {
        stream.data += chunk;
        if (stream.data.includes(': connected')) resolve(stream);
      });
    });
    req.on('error', reject);
  });
}

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timed out: ${what}`)), ms))]);
}

const until = async (cond: () => boolean, ms: number) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('condition not met');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('remote entry: event stream revocation', () => {
  it('answers 401 when the session fails the re-check before the stream opens', async () => {
    const { app: a, auth: ra } = mk();
    const id = await signIn(a);
    const real = ra.check.bind(ra);
    let calls = 0;
    // The auth hook sees a valid session; the handler's re-check sees it gone (a sign-out in between).
    const check = vi.spyOn(ra, 'check').mockImplementation((v) => (++calls === 1 ? real(v) : { ok: false }));
    const res = await a.inject({ method: 'GET', url: '/api/events', headers: withSession(id) });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('re-issues a due session cookie on the event stream response', async () => {
    const { app: a } = mk();
    const id = await signIn(a);
    clock += DAY_MS + 60_000;
    await a.listen({ port: 0, host: '127.0.0.1' });
    const stream = await openStream((a.server.address() as AddressInfo).port, id);
    try {
      expect(String(stream.headers['set-cookie'])).toMatch(new RegExp(`^${COOKIE}=${id}; .*Max-Age=2592000`));
    } finally {
      stream.req.destroy();
    }
  });

  it('the heartbeat ends the stream of a session that has expired', async () => {
    const { app: a } = mk({ heartbeatMs: 50 });
    const id = await signIn(a);
    await a.listen({ port: 0, host: '127.0.0.1' });
    const stream = await openStream((a.server.address() as AddressInfo).port, id);
    try {
      await new Promise((r) => setTimeout(r, 120));
      expect(stream.isEnded()).toBe(false);
      expect(stream.data).toContain(': ping');
      clock += 31 * DAY_MS;
      await within(stream.ended, 2000, 'stream to end');
      expect(stream.data).toContain('data: {"type":"auth.revoked"}\n\n');
    } finally {
      stream.req.destroy();
    }
  });

  it('heartbeats do not consume the cookie refresh of a long-lived stream', async () => {
    const { app: a } = mk({ heartbeatMs: 30 });
    const id = await signIn(a);
    await a.listen({ port: 0, host: '127.0.0.1' });
    const stream = await openStream((a.server.address() as AddressInfo).port, id);
    try {
      clock += DAY_MS + 60_000;
      await new Promise((r) => setTimeout(r, 150));
      expect(stream.isEnded()).toBe(false);
      const res = await a.inject({ method: 'GET', url: '/api/sessions', headers: withSession(id) });
      expect(res.statusCode).toBe(200);
      expect(String(res.headers['set-cookie'])).toMatch(new RegExp(`^${COOKIE}=${id}; .*Max-Age=2592000`));
    } finally {
      stream.req.destroy();
    }
  });

  it('an idle stream ends once its session expires, however the clock advances', async () => {
    const { app: a } = mk({ heartbeatMs: 30 });
    const id = await signIn(a);
    await a.listen({ port: 0, host: '127.0.0.1' });
    const stream = await openStream((a.server.address() as AddressInfo).port, id);
    try {
      for (let i = 0; i < 2; i++) {
        clock += 10 * DAY_MS;
        await new Promise((r) => setTimeout(r, 100));
        expect(stream.isEnded()).toBe(false);
      }
      clock += 11 * DAY_MS;
      await within(stream.ended, 2000, 'stream to end');
      expect(stream.data).toContain('data: {"type":"auth.revoked"}\n\n');
    } finally {
      stream.req.destroy();
    }
  });

  it('revocation sends auth.revoked and closes the event stream', async () => {
    const { app: a, bus } = mk();
    const idA = await signIn(a);
    const idB = await signIn(a);
    await a.listen({ port: 0, host: '127.0.0.1' });
    const port = (a.server.address() as AddressInfo).port;
    const streamA = await openStream(port, idA);
    const streamB = await openStream(port, idB);
    try {
      // Signing out A closes only A's stream.
      const out = await a.inject({ method: 'POST', url: '/auth/logout', headers: withSession(idA) });
      expect(out.statusCode).toBe(204);
      await within(streamA.ended, 2000, 'stream A to end');
      expect(streamA.data).toContain('data: {"type":"auth.revoked"}\n\n');
      expect(streamB.isEnded()).toBe(false);
      bus.emit({ type: 'activity.updated', sessionId: 's1' });
      await until(() => streamB.data.includes('"activity.updated"'), 2000);
      expect(streamB.data).not.toContain('auth.revoked');

      // logout-all (epoch bump from the CLI) closes every remaining stream within the poll interval.
      bumpEpoch();
      await within(streamB.ended, 2000, 'stream B to end');
      expect(streamB.data).toContain('data: {"type":"auth.revoked"}\n\n');
      expect((await a.inject({ method: 'GET', url: '/api/sessions', headers: withSession(idB) })).statusCode).toBe(401);
    } finally {
      streamA.req.destroy();
      streamB.req.destroy();
    }
  });
});
