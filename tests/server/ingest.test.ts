import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../src/server/app.js';
import { UnitStore } from '../../src/server/store.js';
import type { ServerEvent } from '../../src/server/events.js';
import type { Thread } from '../../src/shared/types.js';

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
    const app = buildApp({ store, token: TOKEN, port: PORT });
    const events: ServerEvent[] = [];
    app.bus.subscribe((e) => events.push(e));
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
    expect(events).toEqual([{ type: 'unit.created', unitId, sessionId: 'sess-1' }]);

    const got = await app.inject({ method: 'GET', url: `/api/units/${unitId}`, headers });
    expect(got.json().id).toBe(unitId);
    const list = await app.inject({ method: 'GET', url: '/api/units?session=sess-1', headers });
    expect(list.json()).toHaveLength(1);
    const sessions = await app.inject({ method: 'GET', url: '/api/sessions', headers });
    expect(sessions.json()[0].sessionId).toBe('sess-1');
  });

  it('new unit marks previous open unit stale and its unresolved threads expired', async () => {
    const store = new UnitStore();
    const app = buildApp({ store, token: TOKEN, port: PORT });
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
    u.threads = [mkThread('t1', 'awaiting'), mkThread('t2', 'resolved')];
    store.save(u);

    const events: ServerEvent[] = [];
    app.bus.subscribe((e) => events.push(e));
    const second = (await stop(app)).json().unitId as string;

    const old = store.get(first)!;
    expect(old.status).toBe('stale');
    expect(old.threads.map((t) => t.status)).toEqual(['expired', 'resolved']);
    expect(store.get(second)!.status).toBe('open');
    expect(events).toContainEqual({ type: 'unit.updated', unitId: first, sessionId: 'sess-1' });
    expect(events).toContainEqual({ type: 'unit.created', unitId: second, sessionId: 'sess-1' });
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
});
