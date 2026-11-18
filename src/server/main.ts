import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { createClaudeAdapter } from '../agents/claude.js';
import { createCodexAdapter, createCodexQueueRunner } from '../agents/codex.js';
import { ActivityTracker } from './activity.js';
import { recoverActivity } from './activity-recovery.js';
import type { AgentKind } from '../shared/types.js';
import { buildApp, type AppDeps } from './app.js';
import { EventBus } from './events.js';
import { PromptBackfill } from './prompt-backfill.js';
import { SessionMetaService, defaultSessionMetaOptions } from './session-meta.js';
import { UnitStore } from './store.js';
import { ThreadEngine } from './threads.js';
import { ensureToken, readConfig, writeServerInfo } from './paths.js';
import { RemoteAuth } from './remote/auth.js';
import { remoteUrls, resolveRemoteConfig } from './remote/config.js';
import { loadOrCreateCert, type TlsMaterial } from './remote/tls.js';

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function listenFailure(e: unknown, bindHost: string, port: number): string {
  if ((e as NodeJS.ErrnoException)?.code === 'EADDRINUSE') return `port ${port} is already in use`;
  const host = isIP(bindHost) === 6 ? `[${bindHost}]` : bindHost;
  return `cannot listen on ${host}:${port}: ${describe(e)}`;
}

/** Starts the external entry when enabled; never throws. Returns the app (for close) or null with the reason logged. */
export async function startRemote(
  deps: Omit<AppDeps, 'remote' | 'token'> & { rawConfig: unknown },
  log: (s: string) => void = console.log,
): Promise<{ app: FastifyInstance; auth: RemoteAuth } | null> {
  const off = (reason: string): null => {
    log(`Remote access is off: ${reason}`);
    return null;
  };
  const { rawConfig, ...shared } = deps;
  let auth: RemoteAuth | null = null;
  let app: FastifyInstance | null = null;
  try {
    const resolved = resolveRemoteConfig(rawConfig);
    if (resolved.status === 'disabled') return null;
    if (resolved.status === 'invalid') return off(resolved.reason);
    const config = resolved.config;

    auth = new RemoteAuth({ sessionDays: config.sessionDays });
    if (!auth.hasPassword()) {
      auth.close();
      return off('no password is set; run `agent-console set-password` first');
    }

    let tls: TlsMaterial;
    try {
      tls = await loadOrCreateCert(config);
    } catch (e) {
      auth.close();
      return off(describe(e));
    }
    log(`Remote access certificate: ${tls.certPath} (SHA-256 ${tls.fingerprint256})`);
    if (tls.regenerated) log('A new self-signed certificate was created; browsers that connect remotely must trust it again.');

    const remoteAuth = auth;
    app = buildApp({
      ...shared,
      // Never consulted by the external entry (it accepts only session cookies); random so it can match nothing.
      token: crypto.randomBytes(32).toString('hex'),
      remote: { config, auth: remoteAuth },
      https: { cert: tls.cert, key: tls.key },
    });
    app.addHook('onClose', async () => remoteAuth.close());
    try {
      await app.listen({ host: config.bindHost, port: config.port });
    } catch (e) {
      await app.close().catch(() => undefined);
      auth.close();
      return off(listenFailure(e, config.bindHost, config.port));
    }
    for (const url of remoteUrls(config)) log(`Remote access: ${url}`);
    return { app, auth };
  } catch (e) {
    // Anything unexpected still leaves the local entry running.
    await app?.close().catch(() => undefined);
    auth?.close();
    return off(describe(e));
  }
}

export async function start(): Promise<void> {
  const config = readConfig();
  const token = ensureToken();
  const store = new UnitStore();
  const bus = new EventBus();
  const engine = new ThreadEngine(store, bus, { claude: createClaudeAdapter(), codex: createCodexAdapter() }, config.concurrency, {
    runTimeoutMs: config.runTimeoutMs,
  });
  const sessionMeta = new SessionMetaService(defaultSessionMetaOptions());
  const activity = new ActivityTracker(bus);
  // Both entries share every service; only the local one sets the engine's submitter and serves hooks.
  const shared = { store, port: config.port, bus, engine, sessionMeta, activity, codexQueue: createCodexQueueRunner() };
  const app = buildApp({ ...shared, token });
  await app.listen({ host: '127.0.0.1', port: config.port });
  writeServerInfo(config.port);
  const locate = (agent: AgentKind, sessionId: string, known?: string) => sessionMeta.transcriptFor(agent, sessionId, known);
  // Turns that were running before a restart are shown as responding again.
  recoverActivity(store, activity, locate).catch((e: unknown) => console.warn(`[activity] recovery failed: ${(e as Error).message}`));
  // Earlier replies get their prompts from the transcripts, in the background.
  new PromptBackfill(store, bus, locate).start();
  console.log(`Agent Console running at http://127.0.0.1:${config.port}/auth?token=${token}`);
  await startRemote({ ...shared, rawConfig: config.remote });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
