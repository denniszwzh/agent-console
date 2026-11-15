import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { EventBus } from '../../src/server/events.js';
import { UnitStore } from '../../src/server/store.js';
import { ThreadEngine } from '../../src/server/threads.js';
import type { ReviewUnit, Thread } from '../../src/shared/types.js';

const TOKEN = 'secret-token';
const PORT = 4317;
const headers = { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}` };

let home: string;
let work: string;
let prev: string | undefined;
beforeEach(() => {
  prev = process.env.AGENT_CONSOLE_HOME;
  home = mkdtempSync(join(tmpdir(), 'ac-cx-'));
  work = mkdtempSync(join(tmpdir(), 'ac-cxw-'));
  process.env.AGENT_CONSOLE_HOME = home;
  writeFileSync(join(work, 'a.md'), '# A\n');
  const rec = (type: string, payload: object) => JSON.stringify({ type, payload });
  writeFileSync(
    join(work, 'rollout.jsonl'),
    [
      rec('event_msg', { type: 'task_started' }),
      rec('response_item', { type: 'custom_tool_call', call_id: 'c1', name: 'apply_patch', input: '*** Begin Patch\n*** Add File: a.md\n+# A\n*** End Patch' }),
      rec('response_item', { type: 'custom_tool_call_output', call_id: 'c1', output: 'Success. Updated the following files:\nA a.md' }),
    ].join('\n') + '\n',
  );
});
afterEach(() => {
  if (prev === undefined) delete process.env.AGENT_CONSOLE_HOME;
  else process.env.AGENT_CONSOLE_HOME = prev;
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

const stop = (app: ReturnType<typeof buildApp>, payload: object) =>
  app.inject({ method: 'POST', url: '/api/hooks/codex/stop', headers, payload });

describe('POST /api/hooks/codex/stop', () => {
  it('requires the token', async () => {
    const app = buildApp({ store: new UnitStore(), token: TOKEN, port: PORT });
    const res = await app.inject({ method: 'POST', url: '/api/hooks/codex/stop', headers: { host: headers.host }, payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('creates a codex unit with reply and rollout files', async () => {
    const store = new UnitStore();
    const app = buildApp({ store, token: TOKEN, port: PORT });
    const res = await stop(app, {
      session_id: 'thr-1',
      transcript_path: join(work, 'rollout.jsonl'),
      cwd: work,
      last_assistant_message: '# Done\n\nok',
    });
    expect(res.statusCode).toBe(200);
    const unit = store.get(res.json().unitId)!;
    expect(unit).toMatchObject({ agent: 'codex', sessionId: 'thr-1', cwd: work, status: 'open' });
    expect(unit.reply.content).toBe('# Done\n\nok');
    expect(unit.files.map((f) => f.path)).toEqual(['a.md']);
  });

  it('accepts a null transcript path and message, and stales the earlier open unit', async () => {
    const store = new UnitStore();
    const app = buildApp({ store, token: TOKEN, port: PORT });
    const first = (await stop(app, { session_id: 'thr-1', transcript_path: null, cwd: work, last_assistant_message: null })).json().unitId;
    expect(store.get(first)!.files).toEqual([]);
    const second = (await stop(app, { session_id: 'thr-1', transcript_path: null, cwd: work, last_assistant_message: 'x' })).json().unitId;
    expect(store.get(first)!.status).toBe('stale');
    expect(store.get(second)!.status).toBe('open');
  });

  it('400 for a session id that could be parsed as a flag (codex and claude routes)', async () => {
    const app = buildApp({ store: new UnitStore(), token: TOKEN, port: PORT });
    for (const url of ['/api/hooks/codex/stop', '/api/hooks/claude/stop']) {
      for (const bad of ['--oss', '-x', 'a b', '.hidden']) {
        const res = await app.inject({ method: 'POST', url, headers, payload: { session_id: bad, cwd: work } });
        expect(res.statusCode).toBe(400);
      }
    }
  });

  it('400 without session_id or cwd', async () => {
    const app = buildApp({ store: new UnitStore(), token: TOKEN, port: PORT });
    expect((await stop(app, { cwd: work })).statusCode).toBe(400);
    expect((await stop(app, { session_id: 's' })).statusCode).toBe(400);
  });

  it('ignores sessions the engine forked itself', async () => {
    const store = new UnitStore();
    const app = buildApp({ store, token: TOKEN, port: PORT, forks: { isForkSession: (id) => id === 'fork-1' } });
    expect((await stop(app, { session_id: 'fork-1', cwd: work })).json()).toEqual({ ignored: true });
    expect(store.listBySession('fork-1')).toEqual([]);
  });
});

describe('submit for a codex unit', () => {
  function setup(queue: (thread: string, msg: string) => Promise<boolean>) {
    const store = new UnitStore();
    const bus = new EventBus();
    const engine = new ThreadEngine(store, bus, {}, 3, { gitStatus: async () => null });
    const app = buildApp({ store, token: TOKEN, port: PORT, bus, engine, codexQueue: queue });
    return { store, app };
  }
  const unit = (agent: 'claude' | 'codex'): ReviewUnit => ({
    id: 'u1',
    agent,
    sessionId: 'thr-9',
    cwd: work,
    createdAt: '2026-01-01T00:00:00.000Z',
    reply: { id: 'r', kind: 'reply', content: 'x', blocks: [] },
    files: [],
    threads: [
      {
        id: 't1',
        unitId: 'u1',
        parentThreadId: null,
        anchor: { sourceId: 'msg:1', blockId: 'b', quote: 'q', headingPath: [], startLine: 1, endLine: 1 },
        forkFromSessionId: 'thr-9',
        sessionId: 'fork',
        status: 'resolved',
        messages: [],
        conclusion: 'Keep it.',
        noConclusion: false,
      } satisfies Thread,
    ],
    status: 'open',
    delivered: false,
    warnings: [],
  });

  it('queues the instruction and records queued: true', async () => {
    const calls: Array<[string, string]> = [];
    const { store, app } = setup(async (t, m) => {
      calls.push([t, m]);
      return true;
    });
    store.save(unit('codex'));
    const res = await app.inject({ method: 'POST', url: '/api/units/u1/submit', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().queued).toBe(true);
    const file = join(home, 'conclusions', 'u1.md');
    expect(existsSync(file)).toBe(true);
    expect(calls).toEqual([['thr-9', `Read the review conclusions in ${file} and apply them.`]]);
    expect(store.get('u1')).toMatchObject({ status: 'submitted', delivery: { queued: true, instruction: calls[0][1] } });
    expect(readFileSync(file, 'utf8')).toBe(res.json().bundle);
  });

  it('still submits when the queue fails or throws', async () => {
    for (const queue of [async () => false, async () => Promise.reject(new Error('x'))]) {
      const { store, app } = setup(queue);
      store.save(unit('codex'));
      const res = await app.inject({ method: 'POST', url: '/api/units/u1/submit', headers });
      expect(res.statusCode).toBe(200);
      expect(res.json().queued).toBe(false);
      expect(store.get('u1')!.delivery?.queued).toBe(false);
      expect(store.get('u1')!.status).toBe('submitted');
    }
  });

  it('marks the unit submitted before awaiting the queue: a concurrent submit gets 409', async () => {
    let release!: (v: boolean) => void;
    const { store, app } = setup(() => new Promise<boolean>((r) => (release = r)));
    store.save(unit('codex'));
    const first = app.inject({ method: 'POST', url: '/api/units/u1/submit', headers });
    await new Promise((r) => setTimeout(r, 100));
    expect(store.get('u1')!.status).toBe('submitted');
    expect((await app.inject({ method: 'POST', url: '/api/units/u1/submit', headers })).statusCode).toBe(409);
    release(true);
    const res = await first;
    expect(res.statusCode).toBe(200);
    expect(res.json().queued).toBe(true);
    expect(store.get('u1')!.delivery?.queued).toBe(true);
  });

  it('does not touch the queue for a claude unit', async () => {
    let called = false;
    const { store, app } = setup(async () => {
      called = true;
      return true;
    });
    store.save(unit('claude'));
    const res = await app.inject({ method: 'POST', url: '/api/units/u1/submit', headers });
    expect(res.json().queued).toBe(false);
    expect(called).toBe(false);
    expect(store.get('u1')!.delivery).toBeUndefined();
  });
});
