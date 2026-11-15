import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../src/server/app.js';
import { UnitStore } from '../../src/server/store.js';

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
});
