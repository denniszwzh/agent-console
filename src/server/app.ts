import crypto from 'node:crypto';
import fs from 'node:fs';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { UnitStore } from './store.js';
import { EventBus } from './events.js';
import { projectOf } from './project.js';
import { ActivityTracker } from './activity.js';
import { createCodexQueueRunner, type CodexQueueRunner } from '../agents/codex.js';
import { registerHookRoutes, type TurnScanner } from './routes/hooks.js';
import { registerUnitRoutes } from './routes/units.js';
import { submitUnit } from './submit.js';
import type { ThreadEngine } from './threads.js';
import { readConfig } from './paths.js';
import { SessionMetaService, defaultSessionMetaOptions } from './session-meta.js';
import { allowedHosts, allowedOrigins, type RemoteConfig } from './remote/config.js';
import type { AuthCheck, RemoteAuth } from './remote/auth.js';
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
  /** Present only for the external entry; absent means the local entry (unchanged behaviour). */
  remote?: { config: RemoteConfig; auth: RemoteAuth };
}

export const COOKIE_NAME = 'ac_token';
/** Session cookie of the external entry; `__Host-` makes the browser require Secure, Path=/ and no Domain. */
export const SESSION_COOKIE = '__Host-ac_session';

const LOGIN_FAILED = 'Wrong username or password';
const INVALID_REQUEST = 'Invalid request';
const REVOKED_EVENT = `data: ${JSON.stringify({ type: 'auth.revoked' })}\n\n`;

function sessionCookie(id: string, maxAgeSec: number): string {
  return `${SESSION_COOKIE}=${id}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`;
}

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
  const { store, token, port, remote } = deps;
  const bus = deps.bus ?? new EventBus();
  const ownsActivity = deps.activity === undefined;
  const activity = deps.activity ?? new ActivityTracker(bus);
  const sessionMeta = deps.sessionMeta ?? new SessionMetaService(defaultSessionMetaOptions());
  const app = Fastify();
  const sseClients = new Set<ServerResponse>();

  const hosts = remote ? allowedHosts(remote.config) : new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = remote ? allowedOrigins(remote.config) : new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  // External entry: the session key each authenticated request was checked against, and the
  // key of every open event stream, so a revoked session's streams can be found and closed.
  const requestKeys = new WeakMap<FastifyRequest, string>();
  const streamKeys = new Map<ServerResponse, { key: string; close: () => void }>();

  /** Checks the external entry's session cookie; re-issues the cookie on the reply when the store asks for it. */
  const checkSession = (req: FastifyRequest, reply: FastifyReply, r: NonNullable<AppDeps['remote']>): AuthCheck => {
    const id = readCookie(req.headers.cookie, SESSION_COOKIE);
    let res: AuthCheck;
    try {
      res = r.auth.check(id);
    } catch (e) {
      req.log.error(e);
      return { ok: false };
    }
    if (res.ok && res.refresh && id !== null) reply.header('Set-Cookie', sessionCookie(id, r.config.sessionDays * 86_400));
    return res;
  };

  const isAuthorized = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (remote) {
      // Only the session cookie counts here: the local token (Bearer or ac_token) is never accepted.
      const res = checkSession(req, reply, remote);
      if (res.ok) requestKeys.set(req, res.key);
      return res.ok;
    }
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ') && safeEqual(auth.slice(7), token)) return true;
    const cookie = readCookie(req.headers.cookie, COOKIE_NAME);
    return cookie !== null && safeEqual(cookie, token);
  };

  // Host/Origin gate: applies to every route, including /auth and unmatched paths.
  app.addHook('onRequest', async (req, reply) => {
    const host = remote ? req.headers.host?.toLowerCase() : req.headers.host;
    if (!host || !hosts.has(host)) return reply.code(403).send({ error: 'forbidden host' });
    const origin = remote ? req.headers.origin?.toLowerCase() : req.headers.origin;
    if (origin !== undefined && !origins.has(origin)) return reply.code(403).send({ error: 'forbidden origin' });
  });

  let stopRevocations: (() => void) | null = null;
  if (remote) {
    const { auth, config } = remote;
    const maxAgeSec = config.sessionDays * 86_400;

    // A signed-out session must not keep receiving events: tell its streams, then end them.
    stopRevocations = auth.onRevoke((keys) => {
      for (const [raw, s] of [...streamKeys]) {
        if (keys !== 'all' && !keys.includes(s.key)) continue;
        s.close();
        raw.end(REVOKED_EVENT);
      }
    });

    app.get('/auth/mode', async (req, reply) => {
      const res = checkSession(req, reply, remote);
      return res.ok ? { mode: 'password', signedIn: true, username: res.username } : { mode: 'password', signedIn: false };
    });

    app.post('/auth/login', {
      // Unparseable or non-JSON bodies (FST_ERR_CTP_*) get the same 400 as a badly shaped one.
      // They never reach login(), so they are not counted as failed sign-ins.
      errorHandler: (err, _req, reply) => {
        if (typeof err.code === 'string' && err.code.startsWith('FST_ERR_CTP_')) {
          return reply.code(400).send({ error: INVALID_REQUEST });
        }
        throw err;
      },
    }, async (req, reply) => {
      const body = req.body as { username?: unknown; password?: unknown } | null | undefined;
      if (typeof body !== 'object' || body === null || typeof body.username !== 'string' || typeof body.password !== 'string') {
        return reply.code(400).send({ error: INVALID_REQUEST });
      }
      const ua = req.headers['user-agent'];
      const res = await auth.login(body.username, body.password, { ip: req.ip, userAgent: typeof ua === 'string' ? ua : '' });
      if (res.ok) {
        reply.header('Set-Cookie', sessionCookie(res.id, maxAgeSec));
        return reply.code(204).send();
      }
      if (res.reason === 'locked') {
        const minutes = Math.ceil(res.retryAfterSec / 60);
        const unit = minutes === 1 ? 'minute' : 'minutes';
        reply.header('Retry-After', String(res.retryAfterSec));
        return reply.code(429).send({ error: `Too many failed sign-ins. Try again in ${minutes} ${unit}.`, retryAfterSec: res.retryAfterSec });
      }
      return reply.code(401).send({ error: LOGIN_FAILED });
    });

    app.post('/auth/logout', async (req, reply) => {
      const id = readCookie(req.headers.cookie, SESSION_COOKIE);
      // Unknown or malformed ids are a no-op; a failed write throws (500) and leaves the cookie in place.
      if (id !== null) auth.logout(id);
      reply.header('Set-Cookie', sessionCookie('', 0));
      return reply.code(204).send();
    });
  } else {
    app.get('/auth/mode', async () => ({ mode: 'token' }));

    app.get('/auth', async (req, reply) => {
      const t = (req.query as { token?: unknown }).token;
      if (typeof t !== 'string' || !safeEqual(t, token)) return reply.code(401).send({ error: 'invalid token' });
      reply.header('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`);
      return reply.redirect('/', 302);
    });
  }

  // Every API route lives inside this encapsulated plugin, so the auth hook is
  // attached to the routes themselves rather than matched against the raw URL.
  app.register(async (api) => {
    api.addHook('onRequest', async (req, reply) => {
      if (!isAuthorized(req, reply)) return reply.code(401).send({ error: 'unauthorized' });
    });

    api.get('/api/events', (req, reply) => {
      let key: string | undefined;
      if (remote) {
        // Defence in depth: re-check the session just before the stream is registered.
        const res = checkSession(req, reply, remote);
        if (!res.ok || res.key !== requestKeys.get(req)) {
          reply.code(401).send({ error: 'unauthorized' });
          return;
        }
        key = res.key;
      }
      reply.hijack();
      const raw = reply.raw;
      const setCookie = reply.getHeader('set-cookie');
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        // A session cookie re-issued by the auth check; hijacking bypasses Fastify's own headers.
        ...(setCookie !== undefined ? { 'Set-Cookie': setCookie } : {}),
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
        streamKeys.delete(raw);
      };
      if (key !== undefined) streamKeys.set(raw, { key, close: cleanup });
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

    // Hooks come only from local agents, and the shared engine's submitter is set once, by the local entry.
    if (!remote) {
      registerHookRoutes(api, { store, bus, config: deps.config ?? readConfig(), forks: deps.forks ?? deps.engine, activity, scanFiles: deps.scanFiles });
    }
    if (deps.engine) {
      const codexQueue = deps.codexQueue ?? createCodexQueueRunner();
      if (!remote) deps.engine.setSubmitter((unitId) => submitUnit({ store, bus, codexQueue }, unitId));
      registerUnitRoutes(api, { engine: deps.engine, store, bus, codexQueue });
    }
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
    // Close only what this instance created; an injected tracker belongs to the caller.
    if (ownsActivity) activity.close();
    stopRevocations?.();
    for (const s of sseClients) s.destroy();
  });
  return app;
}
