import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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
import { conclusionFile, pathKey } from '../paths.js';
import type { ActivityTracker } from '../activity.js';
import { MAX_SCAN_FILES, scanTurnFiles, type TurnScan } from '../turn-files.js';

export type TurnScanner = (cwd: string, sinceMs: number) => Promise<TurnScan | null>;

/** Same-file key for a path as recorded by the agent or found by the scan (junctions/subst resolved). */
function fileKey(p: string, cwd: string): string {
  const abs = path.resolve(cwd, p);
  try {
    return pathKey(fs.realpathSync.native(abs));
  } catch {
    return pathKey(abs);
  }
}

/** Shown relative to the session folder when inside it (like most agent-recorded paths). */
function displayPath(abs: string, cwd: string): string {
  const rel = path.relative(cwd, abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs;
}

interface StopBody {
  session_id?: unknown;
  transcript_path?: unknown;
  cwd?: unknown;
  last_assistant_message?: unknown;
}

export function registerHookRoutes(
  app: FastifyInstance,
  deps: {
    store: UnitStore;
    bus: EventBus;
    config: Config;
    forks?: ForkRegistry;
    activity?: ActivityTracker;
    /** End-of-turn scan for files the agent wrote outside its edit tools; defaults to scanTurnFiles. */
    scanFiles?: TurnScanner;
  },
): void {
  const { store, bus, config, forks, activity } = deps;
  const scanFiles = deps.scanFiles ?? scanTurnFiles;

  // Stops of one session are ingested in arrival order: the scan is awaited, and a slow Stop must
  // not save its unit after (and stale) the unit of a later turn.
  const queues = new Map<string, Promise<unknown>>();
  const inOrder = <T>(sessionId: string, fn: () => Promise<T>): Promise<T> => {
    const run = (queues.get(sessionId) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => undefined);
    queues.set(sessionId, tail);
    void tail.then(() => {
      if (queues.get(sessionId) === tail) queues.delete(sessionId);
    });
    return run;
  };

  /**
   * Shared Stop ingestion: validates the body, snapshots changed files (the agent's own edit records,
   * plus the end-of-turn scan when the turn's start is known), stales earlier open units.
   */
  const ingestStop = async (
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
    // Taken on arrival: the turn this Stop ends, and its time, must not drift while the scan runs.
    const createdAt = new Date().toISOString();
    const since = activity?.startedAt(sessionId);

    return inOrder(sessionId, async () => {
      const replySource: Source = {
        id: randomUUID(),
        kind: 'reply',
        content: message,
        blocks: splitBlocks(message, 'markdown'),
      };
      const files = transcriptPath ? findFiles(transcriptPath, sessionId).map((p) => takeSnapshot(p, cwd)) : [];
      // The scan needs the turn's start, which only the prompt hook records.
      const scan = since === undefined ? null : await scanFiles(cwd, since);
      let scanNotice: ReviewUnit['scanNotice'];
      if (scan) {
        const known = new Set(files.map((f) => fileKey(f.path ?? '', cwd)));
        // Hits are newest first, so the cap keeps the most recent changes.
        const fresh = scan.hits.filter((h) => !known.has(fileKey(h.path, cwd)));
        const added = fresh.slice(0, MAX_SCAN_FILES).sort((a, b) => a.path.localeCompare(b.path));
        for (const h of added) files.push({ ...takeSnapshot(displayPath(h.path, cwd), cwd), detectedBy: scan.method });
        const omitted = fresh.length - added.length;
        if (omitted > 0 || scan.incomplete) scanNotice = { omitted, incomplete: scan.incomplete };
      }

      const unit: ReviewUnit = {
        id: randomUUID(),
        agent,
        sessionId,
        cwd,
        createdAt,
        reply: replySource,
        files,
        threads: [],
        status: 'open',
        delivered: false,
        warnings: [],
        ...(scanNotice ? { scanNotice } : {}),
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
      // Only the turn this Stop ends: a prompt sent while the scan ran has started a newer one.
      if (activity && activity.startedAt(sessionId) === since) activity.end(sessionId);

      for (const prev of staled) {
        forks?.abortUnitRuns?.(prev.id);
        bus.emit({ type: 'unit.updated', unitId: prev.id, sessionId });
      }
      bus.emit({ type: 'unit.created', unitId: unit.id, sessionId });
      return { unitId: unit.id };
    });
  };

  app.post('/api/hooks/claude/stop', async (req, reply) =>
    ingestStop('claude', findChangedFilesClaude, (req.body ?? {}) as StopBody, reply),
  );

  app.post('/api/hooks/codex/stop', async (req, reply) =>
    ingestStop('codex', (rollout) => findChangedFilesCodex(rollout), (req.body ?? {}) as StopBody, reply),
  );

  // Called by the UserPromptSubmit hook on every prompt: returns what to inject (or block), and,
  // unless the prompt is blocked, marks the session as working on a turn until its Stop arrives.
  // Codex has no prompt injection; these two hooks only drive the "responding" status.
  app.post('/api/hooks/codex/prompt', async (req, reply) => {
    const body = (req.body ?? {}) as { session_id?: unknown; cwd?: unknown; transcript_path?: unknown; prompt?: unknown; turn_id?: unknown };
    const sessionId = body.session_id;
    if (!isSafeId(sessionId)) return reply.code(400).send({ error: 'invalid session_id' });
    if (forks?.isForkSession(sessionId)) return { ignored: true };
    activity?.start({
      sessionId,
      agent: 'codex',
      cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
      transcriptPath: typeof body.transcript_path === 'string' ? body.transcript_path : undefined,
      prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
      turnId: typeof body.turn_id === 'string' ? body.turn_id : undefined,
    });
    return { ok: true };
  });

  app.post('/api/hooks/codex/interrupt', async (req, reply) => {
    const body = (req.body ?? {}) as { session_id?: unknown; turn_id?: unknown };
    const sessionId = body.session_id;
    if (!isSafeId(sessionId)) return reply.code(400).send({ error: 'invalid session_id' });
    activity?.end(sessionId, typeof body.turn_id === 'string' ? body.turn_id : undefined);
    return { ok: true };
  });

  app.get('/api/hooks/claude/prompt', async (req, reply) => {
    const q = req.query as { session?: unknown; cwd?: unknown; transcript?: unknown; prompt?: unknown };
    const session = q.session;
    if (typeof session !== 'string' || !session) return reply.code(400).send({ error: 'session query required' });
    const startTurn = () => {
      if (!activity || !isSafeId(session) || forks?.isForkSession(session)) return;
      activity.start({
        sessionId: session,
        agent: 'claude',
        cwd: typeof q.cwd === 'string' ? q.cwd : undefined,
        transcriptPath: typeof q.transcript === 'string' ? q.transcript : undefined,
        prompt: typeof q.prompt === 'string' ? q.prompt : undefined,
      });
    };

    const units = store.listBySession(session);
    const pending = units
      .filter((u) => u.status === 'submitted' && !u.delivered)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (pending) {
      // Two-phase delivery: only the hook's ack (after it wrote the text) marks the unit delivered,
      // so a hook killed mid-way re-injects next time instead of losing the conclusions.
      const text = `Conclusions file: ${conclusionFile(pending.id)}\n\n${buildConclusionBundle(pending)}`;
      startTurn();
      return { action: 'inject', text, unitId: pending.id };
    }

    if (config.hardGate) {
      const latestOpen = units
        .filter((u) => u.status === 'open')
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      const n = latestOpen ? latestOpen.threads.filter((t) => t.status !== 'resolved').length : 0;
      if (n > 0) {
        return {
          action: 'block',
          reason: `Agent Console: ${n} review thread(s) still open. Finish them (or delete drafts) before continuing.`,
        };
      }
    }
    startTurn();
    return { action: 'none' };
  });

  app.post('/api/hooks/claude/prompt/ack', async (req, reply) => {
    const unitId = ((req.body ?? {}) as { unitId?: unknown }).unitId;
    if (!isSafeId(unitId)) return reply.code(400).send({ error: 'unitId required' });
    const unit = store.get(unitId);
    if (!unit) return reply.code(404).send({ error: 'unit not found' });
    if (unit.status !== 'submitted') return reply.code(409).send({ error: `unit is ${unit.status}` });
    if (!unit.delivered) {
      unit.delivered = true;
      store.save(unit);
      bus.emit({ type: 'unit.updated', unitId: unit.id, sessionId: unit.sessionId });
    }
    return { ok: true };
  });
}
