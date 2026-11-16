import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { appendFileSync, copyFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../src/server/app.js';
import { UnitStore } from '../../src/server/store.js';
import { EventBus } from '../../src/server/events.js';
import { ActivityTracker } from '../../src/server/activity.js';
import type { ServerEvent, Thread } from '../../src/shared/types.js';

const TOKEN = 'secret-token';
const PORT = 4317;
const headers = { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}` };
const fixture = fileURLToPath(new URL('../fixtures/claude-transcript-basic.jsonl', import.meta.url));

let home: string;
let work: string;
let prev: string | undefined;

beforeEach(() => {
  prev = process.env.AGENT_CONSOLE_HOME;
  home = mkdtempSync(join(tmpdir(), 'ac-ing-'));
  work = mkdtempSync(join(tmpdir(), 'ac-work-'));
  process.env.AGENT_CONSOLE_HOME = home;
  writeFileSync(join(work, 'a.md'), '# A\n\nhello\n');
  writeFileSync(join(work, 'b.ts'), 'export const b = 1;\n');
  copyFileSync(fixture, join(work, 't.jsonl'));
});
afterEach(() => {
  if (prev === undefined) delete process.env.AGENT_CONSOLE_HOME;
  else process.env.AGENT_CONSOLE_HOME = prev;
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

const stop = (app: ReturnType<typeof buildApp>, sessionId = 'sess-1', msg = '# Done\n\nAll good.') =>
  app.inject({
    method: 'POST',
    url: '/api/hooks/claude/stop',
    headers,
    payload: { session_id: sessionId, transcript_path: join(work, 't.jsonl'), cwd: work, last_assistant_message: msg },
  });

describe('stop hook ingestion', () => {
  it('creates unit with reply blocks and file snapshots', async () => {
    const store = new UnitStore();
    const bus = new EventBus();
    const app = buildApp({ store, token: TOKEN, port: PORT, bus });
    const events: ServerEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const res = await stop(app);
    expect(res.statusCode).toBe(200);
    const { unitId } = res.json();
    const unit = store.get(unitId)!;
    expect(unit).toMatchObject({ agent: 'claude', sessionId: 'sess-1', cwd: work, status: 'open', delivered: false, threads: [], warnings: [] });
    expect(unit.reply.kind).toBe('reply');
    expect(unit.reply.content).toBe('# Done\n\nAll good.');
    expect(unit.reply.blocks.length).toBeGreaterThan(0);
    expect(unit.files.map((f) => f.path)).toEqual(['a.md', 'b.ts']);
    expect(unit.files[0].content).toBe('# A\n\nhello\n');
    // The turn's prompts are added afterwards (unit.updated), whenever the transcript read finishes.
    expect(events.filter((e) => e.type !== 'unit.updated')).toEqual([{ type: 'unit.created', unitId, sessionId: 'sess-1' }]);

    const got = await app.inject({ method: 'GET', url: `/api/units/${unitId}`, headers });
    expect(got.json().id).toBe(unitId);
    const list = await app.inject({ method: 'GET', url: '/api/units?session=sess-1', headers });
    expect(list.json()).toHaveLength(1);
    const sessions = await app.inject({ method: 'GET', url: '/api/sessions', headers });
    expect(sessions.json()[0].sessionId).toBe('sess-1');
  });

  it('new unit marks previous open unit stale and expires only its unsent and unfinished threads', async () => {
    const store = new UnitStore();
    const bus = new EventBus();
    const app = buildApp({ store, token: TOKEN, port: PORT, bus });
    const first = (await stop(app)).json().unitId as string;
    const u = store.get(first)!;
    const mkThread = (id: string, status: Thread['status']): Thread => ({
      id,
      unitId: first,
      parentThreadId: null,
      forkFromSessionId: 'sess-1',
      sessionId: null,
      status,
      messages: [],
      conclusion: null,
      noConclusion: false,
      anchor: { sourceId: 's', blockId: 'b', quote: '', headingPath: [], startLine: 1, endLine: 1 },
    });
    u.threads = [mkThread('t1', 'awaiting'), mkThread('t2', 'resolved'), mkThread('t3', 'draft'), mkThread('t4', 'answering')];
    store.save(u);

    const events: ServerEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const second = (await stop(app)).json().unitId as string;

    const old = store.get(first)!;
    expect(old.status).toBe('stale');
    expect(old.threads.map((t) => t.status)).toEqual(['awaiting', 'resolved', 'expired', 'expired']);
    expect(store.get(second)!.status).toBe('open');
    expect(events).toContainEqual({ type: 'unit.updated', unitId: first, sessionId: 'sess-1' });
    expect(events).toContainEqual({ type: 'unit.created', unitId: second, sessionId: 'sess-1' });
  });

  it('a thread being concluded when the unit goes stale keeps its answer', async () => {
    const store = new UnitStore();
    const bus = new EventBus();
    const app = buildApp({ store, token: TOKEN, port: PORT, bus });
    const first = (await stop(app)).json().unitId as string;
    const u = store.get(first)!;
    u.threads = [
      {
        id: 't1',
        unitId: first,
        parentThreadId: null,
        forkFromSessionId: 'sess-1',
        sessionId: 'fork',
        status: 'answering',
        messages: [],
        conclusion: null,
        noConclusion: false,
        anchor: { sourceId: 's', blockId: 'b', quote: '', headingPath: [], startLine: 1, endLine: 1 },
      },
    ];
    u.integrating = true;
    store.save(u);
    await stop(app);
    expect(store.get(first)!.threads[0].status).toBe('awaiting');
    expect(store.get(first)!.integrating).toBeUndefined();
  });

  it('ignores fork sessions', async () => {
    const store = new UnitStore();
    const app = buildApp({ store, token: TOKEN, port: PORT, forks: { isForkSession: (id) => id === 'fork-1' } });
    const res = await stop(app, 'fork-1');
    expect(res.json()).toEqual({ ignored: true });
    expect(store.listSessions()).toEqual([]);
  });

  it('rejects a body without session_id', async () => {
    const app = buildApp({ store: new UnitStore(), token: TOKEN, port: PORT });
    const res = await app.inject({ method: 'POST', url: '/api/hooks/claude/stop', headers, payload: { cwd: work } });
    expect(res.statusCode).toBe(400);
  });

  describe('end-of-turn scan', () => {
    const promptHook = (app: ReturnType<typeof buildApp>, sessionId = 'sess-1') =>
      app.inject({ method: 'GET', url: `/api/hooks/claude/prompt?session=${sessionId}&cwd=${encodeURIComponent(work)}`, headers });

    it('adds scanned files after the recorded ones, skipping duplicates and marking how they were found', async () => {
      const bus = new EventBus();
      const activity = new ActivityTracker(bus);
      const calls: [string, number][] = [];
      writeFileSync(join(work, 'shell.txt'), 'from a shell command');
      const scanFiles = async (cwd: string, since: number) => {
        calls.push([cwd, since]);
        // a.md is already in the transcript's edit records (relative path there, absolute here).
        return {
          method: 'git' as const,
          hits: [join(work, 'shell.txt'), join(work, 'a.md')].map((p) => ({ path: p, mtimeMs: 1 })),
          incomplete: false,
        };
      };
      const store = new UnitStore();
      const app = buildApp({ store, token: TOKEN, port: PORT, bus, activity, scanFiles });
      expect((await promptHook(app)).statusCode).toBe(200);
      const since = activity.startedAt('sess-1')!;
      const unit = store.get((await stop(app)).json().unitId)!;
      expect(calls).toEqual([[work, since]]);
      expect(unit.files.map((f) => [f.path, f.detectedBy])).toEqual([
        ['a.md', undefined],
        ['b.ts', undefined],
        ['shell.txt', 'git'],
      ]);
      expect(unit.files[2].content).toBe('from a shell command');
      expect(activity.list()).toEqual([]);
      activity.close();
    });

    it('does not scan when the turn start is unknown (no prompt hook ran)', async () => {
      let called = false;
      const store = new UnitStore();
      const app = buildApp({
        store,
        token: TOKEN,
        port: PORT,
        scanFiles: async () => {
          called = true;
          return null;
        },
      });
      const unit = store.get((await stop(app)).json().unitId)!;
      expect(called).toBe(false);
      expect(unit.files.map((f) => f.path)).toEqual(['a.md', 'b.ts']);
    });

    it('uses the real modification-time scan in a folder without git', async () => {
      const bus = new EventBus();
      const activity = new ActivityTracker(bus);
      const store = new UnitStore();
      const app = buildApp({ store, token: TOKEN, port: PORT, bus, activity });
      // Files from before the prompt are not part of the turn.
      const before = (Date.now() - 60_000) / 1000;
      for (const f of ['a.md', 'b.ts', 't.jsonl']) utimesSync(join(work, f), before, before);
      await promptHook(app);
      writeFileSync(join(work, 'made-by-shell.md'), '# hi');
      const unit = store.get((await stop(app)).json().unitId)!;
      const scanned = unit.files.filter((f) => f.detectedBy);
      // A git checkout above the temp folder would turn this into a git scan; tmp is not one here.
      expect(scanned.map((f) => [f.path, f.detectedBy])).toEqual([['made-by-shell.md', 'mtime']]);
      activity.close();
    });

    it('caps scanned files after dropping recorded ones, keeping the newest, and says how many were left out', async () => {
      const bus = new EventBus();
      const activity = new ActivityTracker(bus);
      // 35 new files (newest first) plus the two recorded ones, which must not use up the cap.
      const fresh = Array.from({ length: 35 }, (_, i) => ({ path: join(work, `gen-${String(i).padStart(2, '0')}.txt`), mtimeMs: 1000 - i }));
      for (const h of fresh) writeFileSync(h.path, 'x');
      const hits = [{ path: join(work, 'a.md'), mtimeMs: 2000 }, { path: join(work, 'b.ts'), mtimeMs: 2000 }, ...fresh];
      const store = new UnitStore();
      const app = buildApp({ store, token: TOKEN, port: PORT, bus, activity, scanFiles: async () => ({ method: 'mtime', hits, incomplete: true }) });
      await promptHook(app);
      const unit = store.get((await stop(app)).json().unitId)!;
      const scanned = unit.files.filter((f) => f.detectedBy).map((f) => f.path);
      expect(scanned).toEqual(fresh.slice(0, 30).map((h) => h.path.slice(work.length + 1)));
      expect(unit.scanNotice).toEqual({ omitted: 5, incomplete: true });
      activity.close();
    });

    it('leaves a turn started while the scan ran alone, and keeps Stops of one session in arrival order', async () => {
      const bus = new EventBus();
      const activity = new ActivityTracker(bus);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let calls = 0;
      const scanFiles = async () => {
        if (++calls === 1) await gate;
        return null;
      };
      const store = new UnitStore();
      const app = buildApp({ store, token: TOKEN, port: PORT, bus, activity, scanFiles });
      await promptHook(app);
      const slow = stop(app, 'sess-1', 'first reply');
      await new Promise((r) => setTimeout(r, 20));
      // The hook gave up waiting; the user sent the next prompt and that turn ended quickly.
      await new Promise((r) => setTimeout(r, 5));
      await promptHook(app);
      const nextSince = activity.startedAt('sess-1');
      const fast = stop(app, 'sess-1', 'second reply');
      await new Promise((r) => setTimeout(r, 20));
      expect(store.listBySession('sess-1')).toEqual([]);
      release();
      const [a, b] = await Promise.all([slow, fast]);
      const first = store.get(a.json().unitId)!;
      const second = store.get(b.json().unitId)!;
      expect(first.reply.content).toBe('first reply');
      expect(first.status).toBe('stale');
      expect(second.status).toBe('open');
      expect(nextSince).toBeDefined();
      // The second Stop ended the second turn; the first Stop did not end it early.
      expect(activity.list()).toEqual([]);
      activity.close();
    });

    it('the first Stop does not end a turn that started while its scan ran', async () => {
      const bus = new EventBus();
      const activity = new ActivityTracker(bus);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const store = new UnitStore();
      const app = buildApp({
        store,
        token: TOKEN,
        port: PORT,
        bus,
        activity,
        scanFiles: async () => {
          await gate;
          return null;
        },
      });
      await promptHook(app);
      const slow = stop(app);
      await new Promise((r) => setTimeout(r, 20));
      await promptHook(app);
      release();
      await slow;
      expect(activity.list().map((a) => a.sessionId)).toEqual(['sess-1']);
      activity.close();
    });
  });
});

describe('stop hook transcript path', () => {
  it('stores the transcript path on the unit', async () => {
    const store = new UnitStore();
    const app = buildApp({ store, token: TOKEN, port: PORT });
    const { unitId } = (await stop(app)).json();
    expect(store.get(unitId)!.transcriptPath).toBe(join(work, 't.jsonl'));
    const rel = await app.inject({
      method: 'POST',
      url: '/api/hooks/claude/stop',
      headers,
      payload: { session_id: 'sess-2', transcript_path: 'relative.jsonl', cwd: work, last_assistant_message: 'x' },
    });
    expect(store.get(rel.json().unitId)!).not.toHaveProperty('transcriptPath');
  });
});

describe('stop hook prompts', () => {
  const T0 = Date.parse('2026-11-16T10:00:00.000Z');
  const userLine = (text: string, at: string) => `${JSON.stringify({ type: 'user', timestamp: at, message: { role: 'user', content: text } })}\n`;
  const stopWith = (app: ReturnType<typeof buildApp>, transcript: string | undefined) =>
    app.inject({
      method: 'POST',
      url: '/api/hooks/claude/stop',
      headers,
      payload: { session_id: 'sess-p', cwd: work, last_assistant_message: 'reply', ...(transcript ? { transcript_path: transcript } : {}) },
    });
  const promptsOf = async (store: UnitStore, unitId: string) => {
    await vi.waitFor(() => expect(store.get(unitId)!.prompts).toBeDefined());
    return store.get(unitId)!.prompts!.map((p) => p.text);
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores the turn prompt on the first unit', async () => {
    const t = join(work, 'p.jsonl');
    writeFileSync(t, userLine('A', '2026-11-16T09:00:00.000Z') + userLine('B', '2026-11-16T09:30:00.000Z'));
    const store = new UnitStore();
    const bus = new EventBus();
    const events: ServerEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const { unitId } = (await stopWith(buildApp({ store, token: TOKEN, port: PORT, bus }), t)).json();
    expect(await promptsOf(store, unitId)).toEqual(['B']);
    expect(events).toContainEqual({ type: 'unit.updated', unitId, sessionId: 'sess-p' });
  });

  it('stores prompts since the previous unit', async () => {
    const t = join(work, 'p.jsonl');
    writeFileSync(t, userLine('A', '2026-11-16T09:00:00.000Z'));
    const store = new UnitStore();
    const app = buildApp({ store, token: TOKEN, port: PORT });
    const first = (await stopWith(app, t)).json().unitId as string;
    expect(await promptsOf(store, first)).toEqual(['A']);
    vi.setSystemTime(T0 + 60_000);
    appendFileSync(t, userLine('C', '2026-11-16T10:00:20.000Z') + userLine('D', '2026-11-16T10:00:40.000Z'));
    const second = (await stopWith(app, t)).json().unitId as string;
    expect(await promptsOf(store, second)).toEqual(['C', 'D']);
  });

  it('creates the unit before reading prompts', async () => {
    const t = join(work, 'later.jsonl');
    const store = new UnitStore();
    const bus = new EventBus();
    const events: ServerEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const res = await stopWith(buildApp({ store, token: TOKEN, port: PORT, bus }), t);
    expect(res.statusCode).toBe(200);
    const { unitId } = res.json();
    expect(events[0]).toEqual({ type: 'unit.created', unitId, sessionId: 'sess-p' });
    expect(await promptsOf(store, unitId)).toEqual([]);
  });

  it('leaves prompts unset without a transcript path', async () => {
    const store = new UnitStore();
    const { unitId } = (await stopWith(buildApp({ store, token: TOKEN, port: PORT }), undefined)).json();
    await new Promise((r) => setTimeout(r, 50));
    expect(store.get(unitId)!.prompts).toBeUndefined();
  });
});
