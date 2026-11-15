import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Anchor } from '../../shared/types.js';
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

export function registerUnitRoutes(app: FastifyInstance, deps: { engine: ThreadEngine }): void {
  const { engine } = deps;

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
}
