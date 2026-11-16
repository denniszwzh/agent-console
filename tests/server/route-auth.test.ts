import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';
import { EventBus } from '../../src/server/events.js';
import { UnitStore } from '../../src/server/store.js';
import { ThreadEngine } from '../../src/server/threads.js';

const PORT = 4317;
const HOST = `127.0.0.1:${PORT}`;
let home: string;
let prev: string | undefined;
beforeEach(() => {
  prev = process.env.AGENT_CONSOLE_HOME;
  home = mkdtempSync(join(tmpdir(), 'ac-routes-'));
  process.env.AGENT_CONSOLE_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.AGENT_CONSOLE_HOME;
  else process.env.AGENT_CONSOLE_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

function fullApp(): { app: FastifyInstance; routes: { method: string; url: string }[] } {
  const store = new UnitStore();
  const bus = new EventBus();
  const engine = new ThreadEngine(store, bus, {}, 1, { gitStatus: async () => null });
  const app = buildApp({
    store,
    token: 'secret',
    port: PORT,
    bus,
    engine,
    config: { port: PORT, concurrency: 1, hardGate: true, runTimeoutMs: 600_000 },
    codexQueue: async () => false,
    webRoot: join(home, 'no-web'),
  });
  const routes: { method: string; url: string }[] = [];
  // Plugin routes are added during ready(), so this hook still sees every /api route.
  app.addHook('onRoute', (r) => {
    for (const m of [r.method].flat()) routes.push({ method: m, url: r.url });
  });
  return { app, routes };
}

/** Every registered /api route that does NOT answer 401 without a token. */
async function unauthenticatedApiRoutes(app: FastifyInstance, routes: { method: string; url: string }[]): Promise<string[]> {
  await app.ready();
  const leaks: string[] = [];
  for (const r of routes) {
    if (!r.url.startsWith('/api/') || r.method === 'HEAD') continue;
    const url = r.url.replace(/:[A-Za-z]+/g, 'x');
    const res = await app.inject({ method: r.method as 'GET', url, headers: { host: HOST }, payload: r.method === 'GET' ? undefined : {} });
    if (res.statusCode !== 401) leaks.push(`${r.method} ${r.url} -> ${res.statusCode}`);
  }
  return leaks;
}

describe('every /api route requires the token (final review item 13)', () => {
  it('enumerates all registered routes and gets 401 from each /api one', async () => {
    const { app, routes } = fullApp();
    try {
      const leaks = await unauthenticatedApiRoutes(app, routes);
      const api = routes.filter((r) => r.url.startsWith('/api/')).map((r) => `${r.method} ${r.url}`);
      // Sanity: the enumeration really saw the hook, unit and thread routes.
      expect(api).toEqual(
        expect.arrayContaining([
          'GET /api/events',
          'GET /api/sessions',
          'GET /api/units/:id',
          'POST /api/hooks/claude/stop',
          'POST /api/hooks/claude/prompt/ack',
          'POST /api/units/:id/integrate',
          'POST /api/threads/:id/send',
          'GET /api/units/:id/image',
        ]),
      );
      expect(leaks).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('would catch an /api route registered outside the authenticated plugin', async () => {
    const { app, routes } = fullApp();
    app.get('/api/leak', async () => ({ ok: true }));
    try {
      expect(await unauthenticatedApiRoutes(app, routes)).toEqual(['GET /api/leak -> 200']);
    } finally {
      await app.close();
    }
  });
});
