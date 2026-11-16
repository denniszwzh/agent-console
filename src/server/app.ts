import crypto from 'node:crypto';
import fs from 'node:fs';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { UnitStore } from './store.js';
import { EventBus } from './events.js';
import { projectOf } from './project.js';
import { ActivityTracker } from './activity.js';
import { createCodexQueueRunner, type CodexQueueRunner } from '../agents/codex.js';
import { registerHookRoutes, type TurnScanner } from './routes/hooks.js';
import { registerUnitRoutes } from './routes/units.js';
import type { ThreadEngine } from './threads.js';
import { readConfig } from './paths.js';
import { SessionMetaService, defaultSessionMetaOptions } from './session-meta.js';
import type { Config, SessionSummary } from '../shared/types.js';

/** Implemented by the thread engine so ingestion can skip sessions it forked itself. */
export interface ForkRegistry {
  isForkSession(sessionId: string): boolean;
  /** Aborts in-flight fork runs of a unit whose threads just expired. */
  abortUnitRuns?(unitId: string): void;
}

export interface AppDeps {
  store: UnitStore;
  token: string;
  port: number;
  forks?: ForkRegistry;
  bus?: EventBus;
  /** "Main session is working on a turn" state; defaults to a fresh tracker on the bus. */
  activity?: ActivityTracker;
  /** End-of-turn file scan used by Stop ingestion; defaults to the real git / modification-time scan. */
  scanFiles?: TurnScanner;
  engine?: ThreadEngine;
  config?: Config;
  /** Sends a message to a Codex thread queue on submit; defaults to the real `codex queue`. */
  codexQueue?: CodexQueueRunner;
  /** Reads session names and times from agent transcripts; defaults to the real ~/.claude and ~/.codex. */
  sessionMeta?: SessionMetaService;
  /** Directory of the built web UI; defaults to <package>/dist/web. */
  webRoot?: string;
}

export const COOKIE_NAME = 'ac_token';

// Resolves to <package>/dist/web from both src/server and dist/server.
const DEFAULT_WEB_ROOT = fileURLToPath(new URL('../../dist/web/', import.meta.url));

const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

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

/**
 * Sessions responding before their first reply, then sessions with replies (newest reply first), each
 * with its name and times from the agent's transcript. The order ignores transcript changes on purpose:
 * the sidebar would otherwise reshuffle while sessions respond. The quick switcher sorts on its own.
 */
function listSessions(store: UnitStore, activity: ActivityTracker, meta: SessionMetaService): SessionSummary[] {
  const replied = store.listSessions();
  const known = new Set(replied.map((s) => s.sessionId));
  const fresh: SessionSummary[] = activity
    .list()
    .filter((a) => !known.has(a.sessionId))
    .map((a) => ({ sessionId: a.sessionId, agent: a.agent, cwd: a.cwd, lastActivity: a.since }));
  return [...fresh, ...replied].map((s) => {
    const project = projectOf(s.cwd);
    return {
      ...s,
      ...meta.describe(s.agent, s.sessionId, store.transcriptPathFor(s.sessionId) ?? activity.transcriptPathFor(s.sessionId)),
      ...(project ? { project } : {}),
    };
  });
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const { store, token, port } = deps;
  const bus = deps.bus ?? new EventBus();
  const activity = deps.activity ?? new ActivityTracker(bus);
  const sessionMeta = deps.sessionMeta ?? new SessionMetaService(defaultSessionMetaOptions());
  const app = Fastify();
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

    api.get('/api/sessions', async () => listSessions(store, activity, sessionMeta));

    api.get('/api/activity', async () => activity.list());

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

    registerHookRoutes(api, { store, bus, config: deps.config ?? readConfig(), forks: deps.forks ?? deps.engine, activity, scanFiles: deps.scanFiles });
    if (deps.engine) registerUnitRoutes(api, { engine: deps.engine, store, bus, codexQueue: deps.codexQueue ?? createCodexQueueRunner() });
  });

  // The built UI is public (it holds no data); every /api call still needs the token.
  const webRoot = deps.webRoot ?? DEFAULT_WEB_ROOT;
  if (fs.existsSync(path.join(webRoot, 'index.html'))) {
    app.register(fastifyStatic, {
      root: webRoot,
      index: 'index.html',
      // Defence in depth: the page may only load from this server (plus data: images).
      setHeaders: (reply) => {
        reply.header('Content-Security-Policy', WEB_CSP);
      },
    });
  }

  app.addHook('onClose', async () => {
    activity.close();
    for (const s of sseClients) s.destroy();
  });
  return app;
}
