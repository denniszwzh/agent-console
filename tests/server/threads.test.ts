import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter, AgentEvent, RunRequest } from '../../src/agents/adapter.js';
import { buildApp } from '../../src/server/app.js';
import { EventBus } from '../../src/server/events.js';
import { UnitStore } from '../../src/server/store.js';
import { questionPrompt } from '../../src/server/prompts.js';
import { ConflictError, ThreadEngine } from '../../src/server/threads.js';
import type { Anchor, ReviewUnit } from '../../src/shared/types.js';

let home: string;
let prev: string | undefined;
beforeEach(() => {
  prev = process.env.AGENT_CONSOLE_HOME;
  home = mkdtempSync(join(tmpdir(), 'ac-thr-'));
  process.env.AGENT_CONSOLE_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.AGENT_CONSOLE_HOME;
  else process.env.AGENT_CONSOLE_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

const anchor: Anchor = { sourceId: 'reply-1', blockId: 'b-0', quote: 'hello world', headingPath: [], startLine: 1, endLine: 1 };

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
  running = 0;
  maxRunning = 0;
  constructor(private script: Script) {}
  async *run(req: RunRequest): AsyncIterable<AgentEvent> {
    const n = this.requests.push(req);
    this.running++;
    this.maxRunning = Math.max(this.maxRunning, this.running);
    try {
      for (const ev of await this.script(req, n)) yield ev;
    } finally {
      this.running--;
    }
  }
}

const answer = (sid: string, text = 'An answer'): AgentEvent[] => [
  { type: 'session', sessionId: sid },
  { type: 'text', text },
  { type: 'done', finalText: text },
];

function setup(
  script: Script,
  concurrency = 3,
  gitStatus: (cwd: string) => Promise<string | null> = async () => null,
  statPath?: (abs: string) => { mtimeMs: number; size: number } | null,
) {
  const store = new UnitStore();
  const bus = new EventBus();
  const adapter = new FakeAdapter(script);
  const engine = new ThreadEngine(store, bus, { claude: adapter }, concurrency, { gitStatus, statPath });
  makeUnit(store);
  return { store, bus, adapter, engine };
}

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe('ThreadEngine', () => {
  it('sendDrafts forks from the main session', async () => {
    const { engine, adapter, store } = setup((_r, n) => answer(`fork-${n}`));
    const t = engine.addDraft('unit-1', anchor, 'why?');
    expect(t.forkFromSessionId).toBe('main-sess');
    engine.sendDrafts('unit-1');
    await engine.whenIdle();
    expect(adapter.requests[0]).toMatchObject({ parentSessionId: 'main-sess', fork: true, cwd: home });
    expect(adapter.requests[0].prompt).toContain('why?');
    expect(adapter.requests[0].prompt).toContain('agent reply');
    const saved = store.get('unit-1')!.threads[0];
    expect(saved.status).toBe('awaiting');
    expect(saved.sessionId).toBe('fork-1');
    expect(saved.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(saved.messages[1].content).toBe('An answer');
    expect(saved.messages[1].blocks?.length).toBeGreaterThan(0);
  });

  it('joins streamed texts then takes finalText as authoritative', async () => {
    const { engine, store } = setup(() => [
      { type: 'session', sessionId: 's' },
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
      { type: 'done', finalText: 'final' },
    ]);
    const t = engine.addDraft('unit-1', anchor, 'q');
    engine.sendDrafts('unit-1');
    await engine.whenIdle();
    expect(store.get('unit-1')!.threads.find((x) => x.id === t.id)!.messages[1].content).toBe('final');

    const { engine: e2, store: s2 } = setup(() => [
      { type: 'session', sessionId: 's' },
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
      { type: 'error', message: 'boom' },
    ]);
    e2.addDraft('unit-1', anchor, 'q');
    e2.sendDrafts('unit-1');
    await e2.whenIdle();
    expect(s2.get('unit-1')!.threads[0].messages[1].content).toBe('one\n\ntwo');
  });

  it('followUp resumes the thread session without fork', async () => {
    const { engine, adapter, store } = setup((_r, n) => answer('fork-1', `a${n}`));
    const t = engine.addDraft('unit-1', anchor, 'q1');
    engine.sendDrafts('unit-1');
    await engine.whenIdle();
    engine.followUp(t.id, 'and then?');
    await engine.whenIdle();
    expect(adapter.requests[1]).toMatchObject({ parentSessionId: 'fork-1', fork: false, prompt: 'and then?' });
    const saved = store.get('unit-1')!.threads[0];
    expect(saved.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(saved.status).toBe('awaiting');
  });

  it('child thread forks from parent thread session', async () => {
    const { engine, adapter } = setup((_r, n) => answer(`fork-${n}`));
    const parent = engine.addDraft('unit-1', anchor, 'q');
    expect(() => engine.addDraft('unit-1', anchor, 'child', parent.id)).toThrow(ConflictError);
    engine.sendDrafts('unit-1');
    await engine.whenIdle();
    const child = engine.addDraft('unit-1', { ...anchor, sourceId: `msg:${parent.messages[0].id}` }, 'child', parent.id);
    expect(child.forkFromSessionId).toBe('fork-1');
    engine.sendDrafts('unit-1');
    await engine.whenIdle();
    expect(adapter.requests[1]).toMatchObject({ parentSessionId: 'fork-1', fork: true });
    expect(adapter.requests[1].prompt).toContain('earlier answer in this review thread');
  });

  it('concurrency limit', async () => {
    const gate = deferred();
    const { engine, adapter } = setup(async (_r, n) => {
      await gate.promise;
      return answer(`fork-${n}`);
    }, 3);
    for (let i = 0; i < 5; i++) engine.addDraft('unit-1', anchor, `q${i}`);
    engine.sendDrafts('unit-1');
    await new Promise((r) => setTimeout(r, 20));
    expect(adapter.running).toBe(3);
    gate.resolve();
    await engine.whenIdle();
    expect(adapter.requests).toHaveLength(5);
    expect(adapter.maxRunning).toBe(3);
  });

  it('resolve blocked until children resolved', async () => {
    const { engine } = setup((_r, n) => (n < 3 ? answer(`fork-${n}`) : [{ type: 'session', sessionId: 'c' }, { type: 'done', finalText: 'ok' }]));
    const parent = engine.addDraft('unit-1', anchor, 'q');
    engine.sendDrafts('unit-1');
    await engine.whenIdle();
    const child = engine.addDraft('unit-1', anchor, 'child', parent.id);
    await expect(engine.resolve(parent.id)).rejects.toBeInstanceOf(ConflictError);
    engine.sendDrafts('unit-1');
    await engine.whenIdle();
    await engine.resolve(child.id);
    await engine.resolve(parent.id);
    expect(engine.getThread(parent.id).status).toBe('resolved');
  });

  it('resolve stores first line of conclusion and passes child conclusions', async () => {
    const { engine, adapter, store } = setup((_r, n) => {
      if (n === 1) return answer('fork-1');
      return [{ type: 'done', finalText: '\n  Decision: keep it.\nSecond line\n' }];
    });
    const t = engine.addDraft('unit-1', anchor, 'q');
    engine.sendDrafts('unit-1');
    await engine.whenIdle();
    await engine.resolve(t.id);
    const saved = store.get('unit-1')!.threads[0];
    expect(saved.conclusion).toBe('Decision: keep it.');
    expect(saved.status).toBe('resolved');
    expect(adapter.requests[1]).toMatchObject({ parentSessionId: 'fork-1', fork: false });
    expect(saved.messages).toHaveLength(2);
  });

  it('canSubmit false with a draft or awaiting thread, true when all resolved', async () => {
    const { engine } = setup((_r, n) => answer(`fork-${n}`));
    expect(engine.canSubmit('unit-1')).toBe(false);
    const t = engine.addDraft('unit-1', anchor, 'q');
    expect(engine.canSubmit('unit-1')).toBe(false);
    engine.sendDrafts('unit-1');
    await engine.whenIdle();
    expect(engine.canSubmit('unit-1')).toBe(false);
    engine.setConclusion(t.id, null);
    expect(engine.getThread(t.id)).toMatchObject({ status: 'resolved', noConclusion: true, conclusion: null });
    expect(engine.canSubmit('unit-1')).toBe(true);
    engine.setConclusion(t.id, 'fix it');
    expect(engine.getThread(t.id)).toMatchObject({ noConclusion: false, conclusion: 'fix it' });
  });

  it('writes on a stale unit throw ConflictError', () => {
    const { engine, store } = setup(() => answer('x'));
    const t = engine.addDraft('unit-1', anchor, 'q');
    const u = store.get('unit-1')!;
    u.status = 'stale';
    store.save(u);
    expect(() => engine.addDraft('unit-1', anchor, 'q2')).toThrow(ConflictError);
    expect(() => engine.sendDrafts('unit-1')).toThrow(ConflictError);
    expect(() => engine.deleteDraft(t.id)).toThrow(ConflictError);
    expect(() => engine.setConclusion(t.id, 'x')).toThrow(ConflictError);
    expect(() => engine.followUp(t.id, 'x')).toThrow(ConflictError);
    expect(() => engine.retry(t.id)).toThrow(ConflictError);
    expect(engine.canSubmit('unit-1')).toBe(false);
  });

  it('deleteDraft only removes drafts', async () => {
    const { engine, store } = setup(() => answer('f'));
    const t = engine.addDraft('unit-1', anchor, 'q');
    engine.deleteDraft(t.id);
    expect(store.get('unit-1')!.threads).toHaveLength(0);
    const t2 = engine.addDraft('unit-1', anchor, 'q');
    engine.sendDrafts('unit-1');
    await engine.whenIdle();
    expect(() => engine.deleteDraft(t2.id)).toThrow(ConflictError);
  });

  it('isForkSession recognizes thread session ids after store reload', async () => {
    const { engine, store, bus } = setup(() => answer('fork-xyz'));
    engine.addDraft('unit-1', anchor, 'q');
    expect(engine.isForkSession('fork-xyz')).toBe(false);
    engine.sendDrafts('unit-1');
    await engine.whenIdle();
    expect(engine.isForkSession('fork-xyz')).toBe(true);
    const reloaded = new ThreadEngine(store, bus, {}, 3);
    expect(reloaded.isForkSession('fork-xyz')).toBe(true);
    expect(reloaded.isForkSession('main-sess')).toBe(false);
  });

  it('adapter error marks thread error and retry succeeds', async () => {
    const { engine, adapter } = setup((_r, n) =>
      n === 1 ? [{ type: 'error', message: 'cli failed' }] : answer('fork-2'),
    );
    const t = engine.addDraft('unit-1', anchor, 'q');
    engine.sendDrafts('unit-1');
    await engine.whenIdle();
    expect(engine.getThread(t.id)).toMatchObject({ status: 'error', error: 'cli failed' });
    engine.retry(t.id);
    await engine.whenIdle();
    expect(adapter.requests[1]).toMatchObject({ parentSessionId: 'main-sess', fork: true });
    expect(adapter.requests[1].prompt).toContain('q');
    expect(engine.getThread(t.id)).toMatchObject({ status: 'awaiting', sessionId: 'fork-2' });
    expect(engine.getThread(t.id).error).toBeUndefined();
  });

  it('a thrown adapter exception marks the thread error', async () => {
    const { engine } = setup(() => {
      throw new Error('spawn failed');
    });
    const t = engine.addDraft('unit-1', anchor, 'q');
    engine.sendDrafts('unit-1');
    await engine.whenIdle();
    expect(engine.getThread(t.id)).toMatchObject({ status: 'error', error: 'spawn failed' });
  });

  it('a unit whose agent has no adapter puts threads in error', async () => {
    const store = new UnitStore();
    makeUnit(store, { agent: 'codex' });
    const engine = new ThreadEngine(store, new EventBus(), {}, 3, { gitStatus: async () => null });
    const t = engine.addDraft('unit-1', anchor, 'q');
    engine.sendDrafts('unit-1');
    await engine.whenIdle();
    expect(engine.getThread(t.id)).toMatchObject({ status: 'error', error: "No adapter for agent 'codex' yet" });
  });

  it('emits unit.updated on changes', async () => {
    const { engine, bus } = setup(() => answer('f'));
    let n = 0;
    bus.subscribe((e) => {
      if (e.type === 'unit.updated' && e.unitId === 'unit-1' && e.sessionId === 'main-sess') n++;
    });
    engine.addDraft('unit-1', anchor, 'q');
    engine.sendDrafts('unit-1');
    await engine.whenIdle();
    expect(n).toBeGreaterThanOrEqual(5);
  });

  it('git status change during a run is recorded in unit.warnings', async () => {
    let calls = 0;
    const { engine, store } = setup(
      () => answer('f'),
      3,
      async () => (calls++ === 0 ? '' : ' M docs/spec.md\nR  old.md -> new.md\n'),
    );
    const t = engine.addDraft('unit-1', anchor, 'q');
    engine.sendDrafts('unit-1');
    await engine.whenIdle();
    const w = store.get('unit-1')!.warnings;
    expect(w).toHaveLength(1);
    expect(w[0].threadId).toBe(t.id);
    expect(w[0].paths).toEqual(['docs/spec.md', 'new.md']);
  });

  it('warns when an already-listed (untracked or modified) file changes content during a run', async () => {
    const stats: Record<string, { mtimeMs: number; size: number }> = { 'docs/a.md': { mtimeMs: 1, size: 10 } };
    const { engine, store } = setup(
      () => {
        stats['docs/a.md'] = { mtimeMs: 2, size: 12 }; // edited while the fork runs
        return answer('f');
      },
      3,
      async () => '?? docs/a.md\n M src/b.ts\n',
      (abs) => stats[abs.split(/[\\/]/).slice(-2).join('/')] ?? { mtimeMs: 5, size: 5 },
    );
    engine.addDraft('unit-1', anchor, 'q');
    engine.sendDrafts('unit-1');
    await engine.whenIdle();
    expect(store.get('unit-1')!.warnings.map((w) => w.paths)).toEqual([['docs/a.md']]);
  });

  it('no warning when listed files are unchanged', async () => {
    const { engine, store } = setup(
      () => answer('f'),
      3,
      async () => '?? docs/a.md\n M src/b.ts\n',
      () => ({ mtimeMs: 1, size: 1 }),
    );
    engine.addDraft('unit-1', anchor, 'q');
    engine.sendDrafts('unit-1');
    await engine.whenIdle();
    expect(store.get('unit-1')!.warnings).toEqual([]);
  });

  it('non-git cwd skips the check', async () => {
    const { engine, store } = setup(() => answer('f'), 3, async () => null);
    engine.addDraft('unit-1', anchor, 'q');
    engine.sendDrafts('unit-1');
    await engine.whenIdle();
    expect(store.get('unit-1')!.warnings).toEqual([]);
  });
});

describe('unit routes', () => {
  const TOKEN = 't';
  const headers = { host: '127.0.0.1:4317', authorization: `Bearer ${TOKEN}` };

  function app(script: Script) {
    const store = new UnitStore();
    const bus = new EventBus();
    const engine = new ThreadEngine(store, bus, { claude: new FakeAdapter(script) }, 3, { gitStatus: async () => null });
    makeUnit(store);
    return { app: buildApp({ store, token: TOKEN, port: 4317, bus, engine }), engine };
  }

  it('requires auth', async () => {
    const { app: a } = app(() => answer('f'));
    const res = await a.inject({ method: 'POST', url: '/api/units/unit-1/send', headers: { host: headers.host } });
    expect(res.statusCode).toBe(401);
  });

  it('runs the full flow and maps errors', async () => {
    const { app: a, engine } = app((_r, n) => (n === 1 ? answer('fork-1') : [{ type: 'done', finalText: 'Done.' }]));
    const bad = await a.inject({ method: 'POST', url: '/api/units/unit-1/threads', headers, payload: { question: 'q' } });
    expect(bad.statusCode).toBe(400);
    const missing = await a.inject({ method: 'POST', url: '/api/units/nope/threads', headers, payload: { anchor, question: 'q' } });
    expect(missing.statusCode).toBe(404);

    const created = await a.inject({ method: 'POST', url: '/api/units/unit-1/threads', headers, payload: { anchor, question: 'q' } });
    expect(created.statusCode).toBe(200);
    const id = created.json().id as string;
    expect((await a.inject({ method: 'POST', url: `/api/threads/${id}/messages`, headers, payload: { text: 'x' } })).statusCode).toBe(409);

    expect((await a.inject({ method: 'POST', url: '/api/units/unit-1/send', headers })).statusCode).toBe(202);
    await engine.whenIdle();
    const fu = await a.inject({ method: 'POST', url: `/api/threads/${id}/messages`, headers, payload: { text: 'more' } });
    expect(fu.statusCode).toBe(202);
    await engine.whenIdle();
    expect((await a.inject({ method: 'POST', url: `/api/threads/${id}/retry`, headers })).statusCode).toBe(409);
    const res = await a.inject({ method: 'POST', url: `/api/threads/${id}/resolve`, headers });
    expect(res.statusCode).toBe(202);
    await engine.whenIdle();
    expect(engine.getThread(id)).toMatchObject({ status: 'resolved', conclusion: 'Done.' });
    const concl = await a.inject({ method: 'PUT', url: `/api/threads/${id}/conclusion`, headers, payload: { conclusion: null } });
    expect(concl.json()).toMatchObject({ noConclusion: true });
    expect((await a.inject({ method: 'PUT', url: `/api/threads/${id}/conclusion`, headers, payload: { conclusion: 5 } })).statusCode).toBe(400);
    expect((await a.inject({ method: 'DELETE', url: `/api/threads/${id}`, headers })).statusCode).toBe(409);
  });

  it('deletes a draft', async () => {
    const { app: a } = app(() => answer('f'));
    const created = await a.inject({ method: 'POST', url: '/api/units/unit-1/threads', headers, payload: { anchor, question: 'q' } });
    const del = await a.inject({ method: 'DELETE', url: `/api/threads/${created.json().id}`, headers });
    expect(del.statusCode).toBe(204);
  });
});

describe('ThreadEngine fix round 1', () => {
  it('reconciles threads left answering after a restart', () => {
    const store = new UnitStore();
    const { engine } = setup(() => answer('f'));
    const t = engine.addDraft('unit-1', anchor, 'q');
    const u = store.get('unit-1')!;
    u.threads[0].status = 'answering';
    store.save(u);
    const reloaded = new ThreadEngine(store, new EventBus(), {}, 3);
    expect(reloaded.getThread(t.id)).toMatchObject({ status: 'error', error: 'Interrupted by server restart' });
    expect(() => reloaded.retry(t.id)).not.toThrow();
  });

  it('an in-flight run does not resurrect an expired thread or touch a non-open unit', async () => {
    const gate = deferred();
    const { engine, store } = setup(async () => {
      await gate.promise;
      return answer('fork-1', 'late answer');
    });
    const t = engine.addDraft('unit-1', anchor, 'q');
    engine.sendDrafts('unit-1');
    await new Promise((r) => setTimeout(r, 10));
    const u = store.get('unit-1')!;
    u.status = 'stale';
    u.threads[0].status = 'expired';
    store.save(u);
    gate.resolve();
    await engine.whenIdle();
    const saved = store.get('unit-1')!.threads.find((x) => x.id === t.id)!;
    expect(saved.status).toBe('expired');
    expect(saved.sessionId).toBe('fork-1');
    expect(saved.messages[1].content).toBe('late answer');
  });

  it('a failing store during fail() does not cause an unhandled rejection', async () => {
    let broken = false;
    class FlakyStore extends UnitStore {
      save(u: ReviewUnit): void {
        if (broken) throw new Error('EPERM');
        super.save(u);
      }
    }
    const store = new FlakyStore();
    makeUnit(store);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const engine = new ThreadEngine(
      store,
      new EventBus(),
      {
        claude: new FakeAdapter(() => {
          broken = true;
          throw new Error('spawn failed');
        }),
      },
      3,
      { gitStatus: async () => null },
    );
    engine.addDraft('unit-1', anchor, 'q');
    engine.sendDrafts('unit-1');
    await engine.whenIdle();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('question prompt keeps the line range for file anchors without headings and msg anchors', () => {
    const a = { ...anchor, startLine: 3, endLine: 5 };
    expect(questionPrompt(a, 'file src/a.ts', 'q')).toContain('file src/a.ts lines 3\u20135');
    expect(questionPrompt({ ...a, headingPath: ['A', 'B'] }, 'file x.md', 'q')).toContain('file x.md \u00a7 A > B lines 3\u20135');
    expect(questionPrompt(a, 'earlier answer in this review thread', 'q')).toContain(
      'earlier answer in this review thread lines 3\u20135',
    );
    expect(questionPrompt(a, 'agent reply', 'q')).toContain('Source: agent reply');
  });

  it('retry after a failed resolve re-runs the conclusion', async () => {
    const { engine, adapter } = setup((_r, n) => {
      if (n === 1) return answer('fork-1');
      if (n === 2) return [{ type: 'error', message: 'conclusion failed' }];
      return [{ type: 'done', finalText: 'Keep as is.' }];
    });
    const t = engine.addDraft('unit-1', anchor, 'q');
    engine.sendDrafts('unit-1');
    await engine.whenIdle();
    await engine.resolve(t.id);
    expect(engine.getThread(t.id).status).toBe('error');
    engine.retry(t.id);
    await engine.whenIdle();
    expect(adapter.requests[2]).toMatchObject({ parentSessionId: 'fork-1', fork: false });
    expect(adapter.requests[2].prompt).toContain('ONE line');
    expect(engine.getThread(t.id)).toMatchObject({ status: 'resolved', conclusion: 'Keep as is.' });
  });

  it('retry after a failed follow-up resends the follow-up text', async () => {
    const { engine, adapter } = setup((_r, n) => {
      if (n === 1) return answer('fork-1');
      if (n === 2) return [{ type: 'error', message: 'nope' }];
      return answer('fork-1', 'ok');
    });
    const t = engine.addDraft('unit-1', anchor, 'q');
    engine.sendDrafts('unit-1');
    await engine.whenIdle();
    engine.followUp(t.id, 'again?');
    await engine.whenIdle();
    engine.retry(t.id);
    await engine.whenIdle();
    expect(adapter.requests[2]).toMatchObject({ parentSessionId: 'fork-1', fork: false, prompt: 'again?' });
  });

  it('retry after an answer that failed after partial text resends the question', async () => {
    const { engine, adapter } = setup((_r, n) =>
      n === 1 ? [{ type: 'session', sessionId: 'f1' }, { type: 'text', text: 'part' }, { type: 'error', message: 'x' }] : answer('f1'),
    );
    const t = engine.addDraft('unit-1', anchor, 'the question');
    engine.sendDrafts('unit-1');
    await engine.whenIdle();
    engine.retry(t.id);
    await engine.whenIdle();
    expect(adapter.requests[1].prompt).toContain('the question');
    expect(engine.getThread(t.id).status).toBe('awaiting');
  });

  it('clamps concurrency to an integer >= 1', async () => {
    for (const [c, expected] of [[0, 1], ['abc', 3]] as const) {
      const gate = deferred();
      const store = new UnitStore();
      makeUnit(store);
      const adapter = new FakeAdapter(async (_r, n) => {
        await gate.promise;
        return answer(`f${n}`);
      });
      const engine = new ThreadEngine(store, new EventBus(), { claude: adapter }, c as unknown as number, {
        gitStatus: async () => null,
      });
      for (let i = 0; i < 4; i++) engine.addDraft('unit-1', anchor, `q${i}`);
      engine.sendDrafts('unit-1');
      await new Promise((r) => setTimeout(r, 20));
      expect(adapter.running).toBe(expected);
      gate.resolve();
      await engine.whenIdle();
      expect(adapter.requests).toHaveLength(4);
      rmSync(join(home, 'units'), { recursive: true, force: true });
    }
  });
});

describe('ThreadEngine ancestor reopening (final review item 1)', () => {
  /** Answers every run; conclusion runs (resume, non-fork) return a one-line conclusion. */
  const script: Script = (req, n) => (req.fork ? answer(`fork-${n}`) : answer(req.parentSessionId, 'Concluded.'));

  async function answered(engine: ThreadEngine, parentId?: string) {
    const t = engine.addDraft('unit-1', anchor, 'q', parentId);
    engine.sendDrafts('unit-1');
    await engine.whenIdle();
    return t;
  }

  it('adding a child under a resolved parent reopens the parent', async () => {
    const { engine, store } = setup(script);
    const p = await answered(engine);
    engine.setConclusion(p.id, 'parent decision');
    expect(engine.getThread(p.id).status).toBe('resolved');
    engine.addDraft('unit-1', anchor, 'child q', p.id);
    expect(store.get('unit-1')!.threads.find((t) => t.id === p.id)).toMatchObject({
      status: 'awaiting',
      conclusion: null,
      noConclusion: false,
    });
  });

  it('a follow-up on a resolved child reopens its resolved parent', async () => {
    const { engine } = setup(script);
    const p = await answered(engine);
    const c = await answered(engine, p.id);
    engine.setConclusion(c.id, 'child decision');
    engine.setConclusion(p.id, null);
    expect(engine.getThread(p.id)).toMatchObject({ status: 'resolved', noConclusion: true });
    engine.followUp(c.id, 'one more thing');
    expect(engine.getThread(p.id)).toMatchObject({ status: 'awaiting', conclusion: null, noConclusion: false });
    await engine.whenIdle();
  });

  it('walks a deeper chain for both a new child and a follow-up', async () => {
    const { engine } = setup(script);
    const p = await answered(engine);
    const c = await answered(engine, p.id);
    const g = await answered(engine, c.id);
    engine.setConclusion(g.id, 'g');
    engine.setConclusion(c.id, 'c');
    engine.setConclusion(p.id, 'p');
    engine.addDraft('unit-1', anchor, 'great-grandchild', g.id);
    for (const id of [g.id, c.id, p.id]) {
      expect(engine.getThread(id)).toMatchObject({ status: 'awaiting', conclusion: null, noConclusion: false });
    }
  });

  it('a follow-up on a resolved grandchild reopens every resolved ancestor', async () => {
    const { engine } = setup(script);
    const p = await answered(engine);
    const c = await answered(engine, p.id);
    const g = await answered(engine, c.id);
    engine.setConclusion(g.id, 'g');
    engine.setConclusion(c.id, 'c');
    engine.setConclusion(p.id, 'p');
    engine.followUp(g.id, 'more?');
    expect(engine.getThread(c.id)).toMatchObject({ status: 'awaiting', conclusion: null });
    expect(engine.getThread(p.id)).toMatchObject({ status: 'awaiting', conclusion: null });
    await engine.whenIdle();
  });

  it('setConclusion rejects drafts and parents with unresolved children', async () => {
    const { engine } = setup(script);
    const d = engine.addDraft('unit-1', anchor, 'draft');
    expect(() => engine.setConclusion(d.id, 'x')).toThrow(ConflictError);
    engine.deleteDraft(d.id);
    const p = await answered(engine);
    await answered(engine, p.id);
    expect(() => engine.setConclusion(p.id, 'x')).toThrow(ConflictError);
  });

  it('a conclusion run that finishes after a child was added leaves the parent awaiting', async () => {
    const gate = deferred();
    const { engine } = setup(async (req, n) => {
      if (req.fork) return answer(`fork-${n}`);
      await gate.promise;
      return answer(req.parentSessionId, 'Too early.');
    });
    const p = await answered(engine);
    const resolving = engine.resolve(p.id);
    await new Promise((r) => setTimeout(r, 10));
    engine.addDraft('unit-1', anchor, 'late child', p.id);
    gate.resolve();
    await resolving;
    expect(engine.getThread(p.id)).toMatchObject({ status: 'awaiting', conclusion: null });
  });
});
