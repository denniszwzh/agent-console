import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Anchor } from '../../shared/types.js';
import { codexInstruction, type CodexQueueRunner } from '../../agents/codex.js';
import { buildConclusionBundle } from '../conclusion.js';
import type { EventBus } from '../events.js';
import { resolveUnitImage } from '../images.js';
import { dataDir } from '../paths.js';
import { takeSnapshot } from '../snapshot.js';
import type { UnitStore } from '../store.js';
import { ConflictError, NotFoundError, ValidationError, type ThreadEngine } from '../threads.js';

function isAnchor(a: unknown): a is Anchor {
  if (!a || typeof a !== 'object') return false;
  const x = a as Record<string, unknown>;
  return (
    typeof x.sourceId === 'string' &&
    typeof x.blockId === 'string' &&
    typeof x.quote === 'string' &&
    Array.isArray(x.headingPath) &&
    typeof x.startLine === 'number' &&
    typeof x.endLine === 'number'
  );
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Comparison key for an absolute path (Windows paths are case-insensitive). */
function pathKey(p: string): string {
  const n = path.normalize(p);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

export function registerUnitRoutes(
  app: FastifyInstance,
  deps: { engine: ThreadEngine; store: UnitStore; bus: EventBus; codexQueue: CodexQueueRunner },
): void {
  const { engine, store, bus, codexQueue } = deps;

  const handle = async (reply: FastifyReply, fn: () => unknown) => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ConflictError) return reply.code(409).send({ error: e.message });
      if (e instanceof NotFoundError) return reply.code(404).send({ error: e.message });
      if (e instanceof ValidationError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  };

  app.post('/api/units/:id/threads', async (req, reply) =>
    handle(reply, () => {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as { anchor?: unknown; question?: unknown; parentThreadId?: unknown };
      if (!isAnchor(body.anchor)) throw new ValidationError('anchor is required');
      if (typeof body.question !== 'string' || !body.question.trim()) throw new ValidationError('question is required');
      if (body.parentThreadId !== undefined && typeof body.parentThreadId !== 'string') {
        throw new ValidationError('parentThreadId must be a string');
      }
      return engine.addDraft(id, body.anchor, body.question, body.parentThreadId);
    }),
  );

  app.delete('/api/threads/:id', async (req, reply) =>
    handle(reply, () => {
      engine.deleteDraft((req.params as { id: string }).id);
      return reply.code(204).send();
    }),
  );

  app.post('/api/units/:id/send', async (req, reply) =>
    handle(reply, () => {
      engine.sendDrafts((req.params as { id: string }).id);
      return reply.code(202).send({ accepted: true });
    }),
  );

  app.post('/api/threads/:id/messages', async (req, reply) =>
    handle(reply, () => {
      const { id } = req.params as { id: string };
      const text = ((req.body ?? {}) as { text?: unknown }).text;
      if (typeof text !== 'string' || !text.trim()) throw new ValidationError('text is required');
      engine.followUp(id, text);
      return reply.code(202).send(engine.getThread(id));
    }),
  );

  app.post('/api/threads/:id/retry', async (req, reply) =>
    handle(reply, () => {
      const { id } = req.params as { id: string };
      engine.retry(id);
      return reply.code(202).send(engine.getThread(id));
    }),
  );

  app.post('/api/threads/:id/resolve', async (req, reply) =>
    handle(reply, () => {
      const { id } = req.params as { id: string };
      engine.checkResolvable(id);
      engine.resolve(id).catch((e) => req.log.error(e));
      return reply.code(202).send(engine.getThread(id));
    }),
  );

  app.put('/api/threads/:id/conclusion', async (req, reply) =>
    handle(reply, () => {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as { conclusion?: unknown };
      if (body.conclusion !== null && typeof body.conclusion !== 'string') {
        throw new ValidationError('conclusion must be a string or null');
      }
      engine.setConclusion(id, body.conclusion);
      return engine.getThread(id);
    }),
  );

  app.post('/api/units/:id/files', async (req, reply) =>
    handle(reply, () => {
      const { id } = req.params as { id: string };
      const filePath = ((req.body ?? {}) as { path?: unknown }).path;
      if (typeof filePath !== 'string' || !filePath.trim()) throw new ValidationError('path is required');
      const unit = store.get(id);
      if (!unit) throw new NotFoundError('unit not found');
      if (unit.status !== 'open') throw new ConflictError(`unit is ${unit.status}`);
      const absolute = path.resolve(unit.cwd, filePath.trim());
      // Never touch network shares or device paths (e.g. \\host\share, \\?\...).
      if (absolute.startsWith('\\\\') || absolute.startsWith('//')) throw new ValidationError('network paths are not allowed');
      if (!isFile(absolute)) throw new ValidationError('file not found');
      const key = pathKey(absolute);
      if (unit.files.some((f) => f.path && pathKey(path.resolve(unit.cwd, f.path)) === key)) {
        throw new ConflictError('file is already part of this review');
      }
      const source = takeSnapshot(filePath.trim(), unit.cwd);
      unit.files.push(source);
      store.save(unit);
      bus.emit({ type: 'unit.updated', unitId: id, sessionId: unit.sessionId });
      return source;
    }),
  );

  app.get('/api/units/:id/image', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { source, path: requested } = req.query as { source?: unknown; path?: unknown };
    const unit = store.get(id);
    const image =
      unit && typeof source === 'string' && typeof requested === 'string' ? resolveUnitImage(unit, source, requested) : null;
    if (!image) return reply.code(404).send({ error: 'not found' });
    return reply
      .header('Content-Type', image.contentType)
      .header('X-Content-Type-Options', 'nosniff')
      // Neutralises scripts in SVG if the image is ever opened directly.
      .header('Content-Security-Policy', 'sandbox')
      .header('Cache-Control', 'no-store')
      .send(fs.createReadStream(image.file));
  });

  app.post('/api/units/:id/submit', async (req, reply) =>
    handle(reply, async () => {
      const { id } = req.params as { id: string };
      const unit = store.get(id);
      if (!unit) throw new NotFoundError('unit not found');
      if (!engine.canSubmit(id)) throw new ConflictError('unit cannot be submitted: open threads remain or unit is not open');
      const bundle = buildConclusionBundle(unit);
      const dir = path.join(dataDir(), 'conclusions');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.resolve(dir, `${id}.md`);
      fs.writeFileSync(file, bundle);
      let queued = false;
      if (unit.agent === 'codex') {
        // Best effort: the UI always offers a copy button too; a queue failure never fails the submit.
        const instruction = codexInstruction(file);
        queued = await codexQueue(unit.sessionId, instruction).catch(() => false);
        unit.delivery = { queued, instruction };
      }
      unit.status = 'submitted';
      unit.delivered = false;
      store.save(unit);
      bus.emit({ type: 'unit.updated', unitId: id, sessionId: unit.sessionId });
      return { bundle, queued };
    }),
  );
}
