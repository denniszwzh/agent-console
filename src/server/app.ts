import crypto from 'node:crypto';
import type { ServerResponse } from 'node:http';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { UnitStore } from './store.js';
import { EventBus } from './events.js';
import { registerHookRoutes } from './routes/hooks.js';

/** Implemented by the thread engine so ingestion can skip sessions it forked itself. */
export interface ForkRegistry {
  isForkSession(sessionId: string): boolean;
}

export interface AppDeps {
  store: UnitStore;
  token: string;
  port: number;
  forks?: ForkRegistry;
  bus?: EventBus;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Event bus shared with the SSE route; later tasks emit through it. */
    bus: EventBus;
  }
}

export const COOKIE_NAME = 'ac_token';

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const { store, token, port } = deps;
  const bus = deps.bus ?? new EventBus();
  const app = Fastify();
  app.decorate('bus', bus);
  const sseClients = new Set<ServerResponse>();

  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  const isAuthorized = (req: FastifyRequest): boolean => {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ') && safeEqual(auth.slice(7), token)) return true;
    const cookie = readCookie(req.headers.cookie, COOKIE_NAME);
    return cookie !== null && safeEqual(cookie, token);
  };

  // Host/Origin gate: applies to every route, including /auth and unmatched paths.
  app.addHook('onRequest', async (req, reply) => {
    const host = req.headers.host;
    if (!host || !hosts.has(host)) return reply.code(403).send({ error: 'forbidden host' });
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(origin)) return reply.code(403).send({ error: 'forbidden origin' });
  });

  app.get('/auth', async (req, reply) => {
    const t = (req.query as { token?: unknown }).token;
    if (typeof t !== 'string' || !safeEqual(t, token)) return reply.code(401).send({ error: 'invalid token' });
    reply.header('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`);
    return reply.redirect('/', 302);
  });

  // Every API route lives inside this encapsulated plugin, so the auth hook is
  // attached to the routes themselves rather than matched against the raw URL.
  app.register(async (api) => {
    api.addHook('onRequest', async (req, reply) => {
      if (!isAuthorized(req)) return reply.code(401).send({ error: 'unauthorized' });
    });

    api.get('/api/events', (req, reply) => {
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      raw.write(': connected\n\n');
      sseClients.add(raw);
      const unsubscribe = bus.subscribe((e) => {
        raw.write(`data: ${JSON.stringify(e)}\n\n`);
      });
      const heartbeat = setInterval(() => raw.write(': ping\n\n'), 25_000);
      heartbeat.unref();
      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        sseClients.delete(raw);
      };
      raw.on('error', cleanup);
      req.raw.on('close', cleanup);
    });

    api.get('/api/sessions', async () => store.listSessions());

    api.get('/api/units', async (req, reply) => {
      const session = (req.query as { session?: unknown }).session;
      if (typeof session !== 'string' || !session) return reply.code(400).send({ error: 'session query required' });
      return store.listBySession(session);
    });

    api.get('/api/units/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const unit = store.get(id);
        if (!unit) return reply.code(404).send({ error: 'not found' });
        return unit;
      } catch (e) {
        req.log.error(e);
        return reply.code(500).send({ error: 'unit unreadable' });
      }
    });

    registerHookRoutes(api, { store, bus, forks: deps.forks });
  });

  app.addHook('onClose', async () => {
    for (const s of sseClients) s.destroy();
  });
  return app;
}
