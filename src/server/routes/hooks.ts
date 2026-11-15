import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AgentKind, Config, ReviewUnit, Source } from '../../shared/types.js';
import { isSafeId } from '../../shared/ids.js';
import { splitBlocks } from '../../shared/blocks.js';
import { findChangedFilesClaude } from '../transcript.js';
import { findChangedFilesCodex } from '../rollout.js';
import { takeSnapshot } from '../snapshot.js';
import type { EventBus } from '../events.js';
import type { UnitStore } from '../store.js';
import type { ForkRegistry } from '../app.js';
import { buildConclusionBundle } from '../conclusion.js';

interface StopBody {
  session_id?: unknown;
  transcript_path?: unknown;
  cwd?: unknown;
  last_assistant_message?: unknown;
}

export function registerHookRoutes(
  app: FastifyInstance,
  deps: { store: UnitStore; bus: EventBus; config: Config; forks?: ForkRegistry },
): void {
  const { store, bus, config, forks } = deps;

  /** Shared Stop ingestion: validates the body, snapshots changed files, stales earlier open units. */
  const ingestStop = (
    agent: AgentKind,
    findFiles: (transcriptPath: string, sessionId: string) => string[],
    body: StopBody,
    reply: FastifyReply,
  ) => {
    const sessionId = body.session_id;
    const cwd = body.cwd;
    if (typeof sessionId !== 'string' || !sessionId || typeof cwd !== 'string' || !cwd) {
      return reply.code(400).send({ error: 'session_id and cwd are required' });
    }
    if (!isSafeId(sessionId)) return reply.code(400).send({ error: 'invalid session_id' });
    if (forks?.isForkSession(sessionId)) return { ignored: true };

    const transcriptPath = typeof body.transcript_path === 'string' ? body.transcript_path : '';
    const message = typeof body.last_assistant_message === 'string' ? body.last_assistant_message : '';

    const replySource: Source = {
      id: randomUUID(),
      kind: 'reply',
      content: message,
      blocks: splitBlocks(message, 'markdown'),
    };
    const files = transcriptPath ? findFiles(transcriptPath, sessionId).map((p) => takeSnapshot(p, cwd)) : [];

    const unit: ReviewUnit = {
      id: randomUUID(),
      agent,
      sessionId,
      cwd,
      createdAt: new Date().toISOString(),
      reply: replySource,
      files,
      threads: [],
      status: 'open',
      delivered: false,
      warnings: [],
    };

    // Supersede earlier open units of this session before the new one exists.
    const staled: ReviewUnit[] = [];
    for (const prev of store.listBySession(sessionId)) {
      if (prev.status !== 'open') continue;
      prev.status = 'stale';
      for (const t of prev.threads) if (t.status !== 'resolved') t.status = 'expired';
      store.save(prev);
      staled.push(prev);
    }
    store.save(unit);

    for (const prev of staled) bus.emit({ type: 'unit.updated', unitId: prev.id, sessionId });
    bus.emit({ type: 'unit.created', unitId: unit.id, sessionId });
    return { unitId: unit.id };
  };

  app.post('/api/hooks/claude/stop', async (req, reply) =>
    ingestStop('claude', findChangedFilesClaude, (req.body ?? {}) as StopBody, reply),
  );

  app.post('/api/hooks/codex/stop', async (req, reply) =>
    ingestStop('codex', (rollout) => findChangedFilesCodex(rollout), (req.body ?? {}) as StopBody, reply),
  );

  app.get('/api/hooks/claude/prompt', async (req, reply) => {
    const session = (req.query as { session?: unknown }).session;
    if (typeof session !== 'string' || !session) return reply.code(400).send({ error: 'session query required' });

    const units = store.listBySession(session);
    const pending = units
      .filter((u) => u.status === 'submitted' && !u.delivered)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (pending) {
      pending.delivered = true;
      store.save(pending);
      bus.emit({ type: 'unit.updated', unitId: pending.id, sessionId: session });
      return { action: 'inject', text: buildConclusionBundle(pending) };
    }

    if (config.hardGate) {
      const latestOpen = units
        .filter((u) => u.status === 'open')
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      const n = latestOpen ? latestOpen.threads.filter((t) => t.status !== 'resolved').length : 0;
      if (n > 0) {
        return {
          action: 'block',
          reason: `Agent Console: ${n} review thread(s) still open. Finish or delete them before continuing.`,
        };
      }
    }
    return { action: 'none' };
  });
}
