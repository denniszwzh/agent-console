import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter, AgentEvent, RunRequest } from '../../src/agents/adapter.js';
import { buildApp } from '../../src/server/app.js';
import { buildConclusionBundle } from '../../src/server/conclusion.js';
import { EventBus } from '../../src/server/events.js';
import { UnitStore } from '../../src/server/store.js';
import { ConflictError, ThreadEngine } from '../../src/server/threads.js';
import type { Anchor, ReviewUnit, Thread } from '../../src/shared/types.js';

let home: string;
let prev: string | undefined;
beforeEach(() => {
  prev = process.env.AGENT_CONSOLE_HOME;
  home = mkdtempSync(join(tmpdir(), 'ac-int-'));
  process.env.AGENT_CONSOLE_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.AGENT_CONSOLE_HOME;
  else process.env.AGENT_CONSOLE_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

const anchor: Anchor = { sourceId: 'reply-1', blockId: 'b-0', quote: 'hello world', headingPath: [], startLine: 1, endLine: 1 };
const msgAnchor = (t: Thread): Anchor => ({ ...anchor, sourceId: `msg:${t.messages[0].id}` });

function makeUnit(store: UnitStore, over: Partial<ReviewUnit> = {}): ReviewUnit {
  const unit: ReviewUnit = {
    id: 'unit-1',
    agent: 'claude',
    sessionId: 'main-sess',
    cwd: home,
    createdAt: new Date().toISOString(),
    reply: { id: 'reply-1', kind: 'reply', content: 'hello world', blocks: [] },
    files: [],
    threads: [],
    status: 'open',
    delivered: false,
    warnings: [],
    ...over,
  };
  store.save(unit);
  return unit;
}

type Script = (req: RunRequest, n: number) => AgentEvent[] | Promise<AgentEvent[]>;

class FakeAdapter implements AgentAdapter {
  kind = 'claude' as const;
  requests: RunRequest[] = [];
  constructor(private script: Script) {}
  async *run(req: RunRequest): AsyncIterable<AgentEvent> {
    const n = this.requests.push(req);
    for (const ev of await this.script(req, n)) yield ev;
  }
}

const answer = (sid: string, text = 'An answer'): AgentEvent[] => [
  { type: 'session', sessionId: sid },
  { type: 'text', text },
  { type: 'done', finalText: text },
];

/** Forks answer as a new session; resumed runs (conclusions) answer with `conclude(req)`. */
const scripted =
  (conclude: (req: RunRequest, n: number) => AgentEvent[] | Promise<AgentEvent[]> = (req) => answer(req.parentSessionId, `Concluded ${req.parentSessionId}.`)): Script =>
  (req, n) =>
    req.fork ? answer(`fork-${n}`) : conclude(req, n);

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

function setup(script: Script) {
  const store = new UnitStore();
  const bus = new EventBus();
  const adapter = new FakeAdapter(script);
  const engine = new ThreadEngine(store, bus, { claude: adapter }, 3, { gitStatus: async () => null });
  const submitted: string[] = [];
  engine.setSubmitter(async (id) => {
    submitted.push(id);
    const u = store.get(id)!;
    u.status = 'submitted';
    store.save(u);
  });
  makeUnit(store);
  return { store, adapter, engine, submitted };
}

describe('ask and sendThread', () => {
  it('ask forks right away and answers', async () => {
    const { engine, adapter, store } = setup(scripted());
    const t = engine.ask('unit-1', anchor, 'why?');
    expect(engine.getThread(t.id).status).toBe('answering');
    await engine.whenIdle();
    expect(adapter.requests[0]).toMatchObject({ parentSessionId: 'main-sess', fork: true });
    expect(adapter.requests[0].prompt).toContain('why?');
    expect(store.get('unit-1')!.threads[0]).toMatchObject({ status: 'awaiting', sessionId: 'fork-1' });
  });

  it('a nested ask forks from the parent thread session, and is refused while the parent is answering', async () => {
    const gate = deferred();
    const { engine, adapter } = setup(async (req, n) => {
      if (n === 2) await gate.promise;
      return req.fork ? answer(`fork-${n}`) : answer(req.parentSessionId, 'more');
    });
    const p = engine.ask('unit-1', anchor, 'q');
    await engine.whenIdle();
    const c = engine.ask('unit-1', msgAnchor(engine.getThread(p.id)), 'child', p.id);
    await new Promise((r) => setTimeout(r, 10));
    expect(adapter.requests[1]).toMatchObject({ parentSessionId: 'fork-1', fork: true });
    gate.resolve();
    await engine.whenIdle();
    engine.followUp(p.id, 'and?');
    expect(() => engine.ask('unit-1', msgAnchor(engine.getThread(p.id)), 'too soon', p.id)).toThrow(ConflictError);
    await engine.whenIdle();
    expect(engine.getThread(c.id).status).toBe('awaiting');
  });

  it('sendThread sends a leftover draft and reopens a concluded parent', async () => {
    const { engine, store, adapter } = setup(scripted());
    const p = engine.ask('unit-1', anchor, 'q');
    await engine.whenIdle();
    const d = engine.addDraft('unit-1', msgAnchor(engine.getThread(p.id)), 'left over', p.id);
    const u = store.get('unit-1')!;
    Object.assign(u.threads.find((t) => t.id === p.id)!, { status: 'resolved', conclusion: 'done' });
    store.save(u);
    engine.sendThread(d.id);
    expect(engine.getThread(p.id)).toMatchObject({ status: 'awaiting', conclusion: null });
    await engine.whenIdle();
    expect(adapter.requests[1]).toMatchObject({ parentSessionId: 'fork-1', fork: true });
    expect(engine.getThread(d.id).status).toBe('awaiting');
    expect(() => engine.sendThread(d.id)).toThrow(ConflictError);
  });

  it('retry always sends the answer again', async () => {
    const { engine, adapter } = setup((req, n) => (n === 1 ? [{ type: 'session', sessionId: 'f1' }, { type: 'text', text: 'part' }, { type: 'error', message: 'x' }] : answer('f1')));
    const t = engine.ask('unit-1', anchor, 'the question');
    await engine.whenIdle();
    expect(engine.getThread(t.id).status).toBe('error');
    engine.retry(t.id);
    await engine.whenIdle();
    expect(adapter.requests[1].prompt).toContain('the question');
    expect(engine.getThread(t.id).status).toBe('awaiting');
  });
});

describe('integrate', () => {
  it('concludes children before parents, keeps the first line, then submits once', async () => {
    const { engine, adapter, store, submitted } = setup(
      scripted((req) => [{ type: 'done', finalText: `\n  Decision for ${req.parentSessionId}.\nSecond line\n` }]),
    );
    const p = engine.ask('unit-1', anchor, 'parent q');
    await engine.whenIdle();
    const c = engine.ask('unit-1', msgAnchor(engine.getThread(p.id)), 'child q', p.id);
    await engine.whenIdle();
    engine.integrate('unit-1');
    expect(store.get('unit-1')!.integrating).toBe(true);
    await engine.whenIdle();
    const conclusions = adapter.requests.filter((r) => !r.fork);
    expect(conclusions.map((r) => r.parentSessionId)).toEqual(['fork-2', 'fork-1']);
    expect(conclusions[1].prompt).toContain('Decision for fork-2.');
    expect(engine.getThread(c.id)).toMatchObject({ status: 'resolved', conclusion: 'Decision for fork-2.' });
    expect(engine.getThread(p.id)).toMatchObject({ status: 'resolved', conclusion: 'Decision for fork-1.' });
    expect(submitted).toEqual(['unit-1']);
    expect(store.get('unit-1')!.integrating).toBe(false);
  });

  it('refuses while a thread is answering, without an answered thread, and twice', async () => {
    const gate = deferred();
    const { engine } = setup(async (req, n) => {
      if (req.fork && n === 1) await gate.promise;
      return scripted()(req, n);
    });
    expect(() => engine.integrate('unit-1')).toThrow(ConflictError);
    engine.ask('unit-1', anchor, 'q');
    expect(() => engine.integrate('unit-1')).toThrow(ConflictError);
    gate.resolve();
    await engine.whenIdle();
    engine.integrate('unit-1');
    expect(() => engine.integrate('unit-1')).toThrow(ConflictError);
    await engine.whenIdle();
  });

  it('a failed thread does not block its parent and is left out', async () => {
    const { engine, adapter, submitted } = setup((req, n) => {
      if (req.fork) return n === 2 ? [{ type: 'error', message: 'boom' }] : answer(`fork-${n}`);
      return answer(req.parentSessionId, 'Parent done.');
    });
    const p = engine.ask('unit-1', anchor, 'q');
    await engine.whenIdle();
    const c = engine.ask('unit-1', msgAnchor(engine.getThread(p.id)), 'child', p.id);
    await engine.whenIdle();
    expect(engine.getThread(c.id).status).toBe('error');
    engine.integrate('unit-1');
    await engine.whenIdle();
    expect(adapter.requests.filter((r) => !r.fork)).toHaveLength(1);
    expect(engine.getThread(p.id).status).toBe('resolved');
    expect(engine.getThread(c.id).status).toBe('error');
    expect(submitted).toEqual(['unit-1']);
  });

  it('a failed conclusion stops integration once every run ends; integrating again reruns only the rest', async () => {
    let failSecond = true;
    const { engine, adapter, store, submitted } = setup((req, n) => {
      if (req.fork) return answer(`fork-${n}`);
      if (req.parentSessionId === 'fork-2' && failSecond) {
        failSecond = false;
        return [{ type: 'error', message: 'conclusion failed' }];
      }
      return answer(req.parentSessionId, 'ok');
    });
    const a = engine.ask('unit-1', anchor, 'a');
    const b = engine.ask('unit-1', anchor, 'b');
    await engine.whenIdle();
    engine.integrate('unit-1');
    await engine.whenIdle();
    expect(store.get('unit-1')).toMatchObject({ integrating: false, integrationError: 'conclusion failed', status: 'open' });
    expect(engine.getThread(a.id).status).toBe('resolved');
    expect(engine.getThread(b.id).status).toBe('awaiting');
    expect(submitted).toEqual([]);
    const runs = adapter.requests.length;
    engine.integrate('unit-1');
    expect(store.get('unit-1')!.integrationError).toBeUndefined();
    await engine.whenIdle();
    expect(adapter.requests.slice(runs).map((r) => r.parentSessionId)).toEqual(['fork-2']);
    expect(submitted).toEqual(['unit-1']);
  });

  it('a thrown conclusion run (timeout, crash) returns the thread to answered', async () => {
    const { engine, store } = setup((req, n) => {
      if (req.fork) return answer(`fork-${n}`);
      throw new Error('spawn failed');
    });
    const t = engine.ask('unit-1', anchor, 'q');
    await engine.whenIdle();
    engine.integrate('unit-1');
    await engine.whenIdle();
    expect(engine.getThread(t.id).status).toBe('awaiting');
    expect(store.get('unit-1')).toMatchObject({ integrating: false, integrationError: 'spawn failed' });
  });

  it('a unit superseded mid-integration is never submitted', async () => {
    const gate = deferred();
    const { engine, store, submitted } = setup(async (req, n) => {
      if (req.fork) return answer(`fork-${n}`);
      await gate.promise;
      return answer(req.parentSessionId, 'late');
    });
    engine.ask('unit-1', anchor, 'q');
    await engine.whenIdle();
    engine.integrate('unit-1');
    await new Promise((r) => setTimeout(r, 10));
    const u = store.get('unit-1')!;
    u.status = 'stale';
    delete u.integrating;
    store.save(u);
    gate.resolve();
    await engine.whenIdle();
    expect(submitted).toEqual([]);
    expect(store.get('unit-1')!.integrationError).toBeUndefined();
  });

  it('ask, follow-up, retry, send and delete are refused while integrating', async () => {
    const gate = deferred();
    const { engine } = setup(async (req, n) => {
      if (req.fork) return answer(`fork-${n}`);
      await gate.promise;
      return answer(req.parentSessionId, 'ok');
    });
    const t = engine.ask('unit-1', anchor, 'q');
    await engine.whenIdle();
    const d = engine.addDraft('unit-1', anchor, 'draft');
    engine.integrate('unit-1');
    expect(() => engine.ask('unit-1', anchor, 'more')).toThrow(ConflictError);
    expect(() => engine.addDraft('unit-1', anchor, 'more')).toThrow(ConflictError);
    expect(() => engine.followUp(t.id, 'more')).toThrow(ConflictError);
    expect(() => engine.retry(t.id)).toThrow(ConflictError);
    expect(() => engine.sendThread(d.id)).toThrow(ConflictError);
    expect(() => engine.deleteDraft(d.id)).toThrow(ConflictError);
    gate.resolve();
    await engine.whenIdle();
  });

  it('without a submitter, integration stops with an error', async () => {
    const store = new UnitStore();
    makeUnit(store);
    const engine = new ThreadEngine(store, new EventBus(), { claude: new FakeAdapter(scripted()) }, 3, { gitStatus: async () => null });
    engine.ask('unit-1', anchor, 'q');
    await engine.whenIdle();
    engine.integrate('unit-1');
    await engine.whenIdle();
    expect(store.get('unit-1')!.integrating).toBe(false);
    expect(store.get('unit-1')!.integrationError).toBeTruthy();
  });
});

describe('restart while integrating', () => {
  const thread = (id: string, status: Thread['status']): Thread => ({
    id,
    unitId: 'unit-1',
    parentThreadId: null,
    anchor,
    forkFromSessionId: 'main-sess',
    sessionId: `fork-${id}`,
    status,
    messages: [{ id: `m-${id}`, role: 'user', content: 'q', createdAt: 'x' }],
    conclusion: status === 'resolved' ? 'done' : null,
    noConclusion: false,
  });

  it('returns concluding threads to answered and stops the integration', () => {
    const store = new UnitStore();
    makeUnit(store, { integrating: true, threads: [thread('a', 'answering'), thread('b', 'resolved')] });
    const engine = new ThreadEngine(store, new EventBus(), {}, 3);
    expect(engine.getThread('a').status).toBe('awaiting');
    expect(store.get('unit-1')).toMatchObject({ integrating: false, integrationError: 'Interrupted by server restart' });
  });

  it('also stops an integration that had nothing left running', () => {
    const store = new UnitStore();
    makeUnit(store, { integrating: true, threads: [thread('b', 'resolved')] });
    new ThreadEngine(store, new EventBus(), {}, 3);
    expect(store.get('unit-1')).toMatchObject({ integrating: false, integrationError: 'Interrupted by server restart' });
  });
});

describe('integrate route and bundle', () => {
  const headers = { host: '127.0.0.1:4317', authorization: 'Bearer t' };

  function app(script: Script) {
    const store = new UnitStore();
    const bus = new EventBus();
    const engine = new ThreadEngine(store, bus, { claude: new FakeAdapter(script) }, 3, { gitStatus: async () => null });
    makeUnit(store);
    const a = buildApp({ store, token: 't', port: 4317, bus, engine, config: { port: 4317, concurrency: 3, hardGate: false, runTimeoutMs: 600_000 } });
    return { a, engine, store };
  }

  it('asks through the route, integrates, and writes the bundle', async () => {
    const gate = deferred();
    const { a, engine, store } = app(async (req, n) => {
      if (req.fork) await gate.promise;
      return scripted((r) => answer(r.parentSessionId, 'Keep it.'))(req, n);
    });
    expect((await a.inject({ method: 'POST', url: '/api/units/nope/integrate', headers })).statusCode).toBe(404);
    const created = await a.inject({ method: 'POST', url: '/api/units/unit-1/threads', headers, payload: { anchor, question: 'q' } });
    expect(created.statusCode).toBe(200);
    expect(created.json().status).toBe('answering');
    expect((await a.inject({ method: 'POST', url: '/api/units/unit-1/integrate', headers })).statusCode).toBe(409);
    gate.resolve();
    await engine.whenIdle();
    expect((await a.inject({ method: 'POST', url: '/api/units/unit-1/integrate', headers })).statusCode).toBe(202);
    expect((await a.inject({ method: 'POST', url: '/api/units/unit-1/integrate', headers })).statusCode).toBe(409);
    await engine.whenIdle();
    const u = store.get('unit-1')!;
    expect(u.status).toBe('submitted');
    expect(existsSync(u.conclusionsPath!)).toBe(true);
    expect(readFileSync(u.conclusionsPath!, 'utf8')).toContain('Keep it.');
  });

  it('sends a leftover draft through the route', async () => {
    const { a, engine } = app(scripted());
    const d = engine.addDraft('unit-1', anchor, 'draft');
    expect((await a.inject({ method: 'POST', url: `/api/threads/${d.id}/send`, headers })).statusCode).toBe(202);
    await engine.whenIdle();
    expect(engine.getThread(d.id).status).toBe('awaiting');
  });

  it('the bundle lists concluded threads, lifting children of failed parents to the top', () => {
    const t = (id: string, status: Thread['status'], parent: string | null = null): Thread => ({
      id,
      unitId: 'unit-1',
      parentThreadId: parent,
      anchor,
      forkFromSessionId: 'main-sess',
      sessionId: `f-${id}`,
      status,
      messages: [{ id: `m-${id}`, role: 'user', content: `question ${id}`, createdAt: 'x' }],
      conclusion: status === 'resolved' ? `conclusion ${id}` : null,
      noConclusion: false,
    });
    const store = new UnitStore();
    const unit = makeUnit(store, {
      threads: [t('a', 'resolved'), t('a1', 'resolved', 'a'), t('b', 'error'), t('b1', 'resolved', 'b'), t('c', 'draft')],
    });
    const md = buildConclusionBundle(unit);
    expect(md).toContain('conclusion a');
    expect(md).toContain('conclusion b1');
    expect(md).not.toContain('conclusion a1');
    expect(md).not.toContain('question b\n');
    expect(md).not.toContain('question c');
    expect(md.match(/^## /gm)).toHaveLength(2);
  });
});
