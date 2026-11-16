import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../src/server/app.js';
import { UnitStore } from '../../src/server/store.js';
import { EventBus } from '../../src/server/events.js';
import { ActivityTracker, acceptableTranscriptPath, isInterruptRecord } from '../../src/server/activity.js';
import { promptQuery } from '../../src/hooks/claude-prompt.js';
import type { ServerEvent } from '../../src/shared/types.js';

const TOKEN = 'secret-token';
const PORT = 4317;
const headers = { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}` };

const SID = '11111111-2222-3333-4444-555555555555';
const userLine = (text: string) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, sessionId: SID });
const assistantLine = (text: string) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const interruptLine = userLine('[Request interrupted by user]');

let home: string;
let work: string;
let prev: string | undefined;

beforeEach(() => {
  prev = process.env.AGENT_CONSOLE_HOME;
  home = mkdtempSync(join(tmpdir(), 'ac-act-'));
  work = mkdtempSync(join(tmpdir(), 'ac-actw-'));
  process.env.AGENT_CONSOLE_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.AGENT_CONSOLE_HOME;
  else process.env.AGENT_CONSOLE_HOME = prev;
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

describe('isInterruptRecord', () => {
  it('matches only the user-side interrupt record', () => {
    expect(isInterruptRecord(interruptLine)).toBe(true);
    expect(isInterruptRecord(userLine('[Request interrupted by user for tool use]'))).toBe(true);
    expect(isInterruptRecord(JSON.stringify({ type: 'user', message: { content: '[Request interrupted by user]' } }))).toBe(true);
    // The marker quoted inside other records (request blobs, assistant text, a prompt mentioning it) does not count.
    expect(isInterruptRecord(assistantLine('[Request interrupted by user]'))).toBe(false);
    expect(isInterruptRecord(userLine('why did I see "[Request interrupted by user]"?'))).toBe(false);
    expect(isInterruptRecord(JSON.stringify({ type: 'api-request-blob', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }))).toBe(false);
    expect(isInterruptRecord('{"type":"user", [Request interrupted by user')).toBe(false);
  });
});

describe('ActivityTracker', () => {
  const setup = () => {
    let now = Date.parse('2026-11-16T10:00:00.000Z');
    const bus = new EventBus();
    const events: ServerEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const tracker = new ActivityTracker(bus, () => now);
    return { tracker, events, advance: (ms: number) => (now += ms) };
  };

  it('start lists the session with a one-line prompt preview, end removes it; each emits activity.updated', () => {
    const { tracker, events } = setup();
    tracker.start({ sessionId: SID, agent: 'claude', cwd: 'C:\\proj', prompt: '\n  fix the build  \nsecond line' });
    expect(tracker.list()).toEqual([
      {
        sessionId: SID,
        agent: 'claude',
        cwd: 'C:\\proj',
        since: '2026-11-16T10:00:00.000Z',
        lastChange: '2026-11-16T10:00:00.000Z',
        prompt: 'fix the build',
      },
    ]);
    expect(tracker.end(SID)).toBe(true);
    expect(tracker.end(SID)).toBe(false);
    expect(tracker.list()).toEqual([]);
    expect(events).toEqual([
      { type: 'activity.updated', sessionId: SID },
      { type: 'activity.updated', sessionId: SID },
    ]);
    tracker.close();
  });

  it('shortens a long prompt', () => {
    const { tracker } = setup();
    tracker.start({ sessionId: SID, agent: 'claude', prompt: 'x'.repeat(300) });
    expect(tracker.list()[0].prompt).toBe(`${'x'.repeat(120)}…`);
    tracker.close();
  });

  it('ends the turn when an interrupt record is appended, ignoring one written before the prompt', () => {
    const { tracker, advance } = setup();
    const t = join(work, 't.jsonl');
    writeFileSync(t, `${interruptLine}\n${userLine('next question')}\n`);
    tracker.start({ sessionId: SID, agent: 'claude', transcriptPath: t });
    tracker.poll();
    expect(tracker.list()).toHaveLength(1);

    advance(5000);
    appendFileSync(t, `${assistantLine('working on it')}\n`);
    tracker.poll();
    expect(tracker.list()[0].lastChange).toBe('2026-11-16T10:00:05.000Z');

    // A record split across two polls is still recognised.
    appendFileSync(t, interruptLine.slice(0, 30));
    tracker.poll();
    expect(tracker.list()).toHaveLength(1);
    appendFileSync(t, `${interruptLine.slice(30)}\n`);
    tracker.poll();
    expect(tracker.list()).toEqual([]);
    tracker.close();
  });

  it('drops a turn whose transcript stayed quiet for an hour', () => {
    const { tracker, advance } = setup();
    const t = join(work, 't.jsonl');
    writeFileSync(t, '');
    tracker.start({ sessionId: SID, agent: 'claude', transcriptPath: t });
    advance(59 * 60 * 1000);
    tracker.poll();
    expect(tracker.list()).toHaveLength(1);
    advance(2 * 60 * 1000);
    tracker.poll();
    expect(tracker.list()).toEqual([]);
    tracker.close();
  });

  it('pushes transcript growth to the panel at most every 30 s', () => {
    const { tracker, events, advance } = setup();
    const t = join(work, 't.jsonl');
    writeFileSync(t, '');
    tracker.start({ sessionId: SID, agent: 'claude', transcriptPath: t });
    events.length = 0;
    advance(10_000);
    appendFileSync(t, `${assistantLine('a')}\n`);
    tracker.poll();
    expect(events).toEqual([]);
    advance(25_000);
    appendFileSync(t, `${assistantLine('b')}\n`);
    tracker.poll();
    expect(events).toEqual([{ type: 'activity.updated', sessionId: SID }]);
    expect(tracker.list()[0].lastChange).toBe('2026-11-16T10:00:35.000Z');
    // No growth: no event.
    advance(60_000);
    tracker.poll();
    expect(events).toHaveLength(1);
    tracker.close();
  });

  it('keeps a multi-byte character split across two polls intact', () => {
    const { tracker } = setup();
    const t = join(work, 't.jsonl');
    writeFileSync(t, '');
    tracker.start({ sessionId: SID, agent: 'claude', transcriptPath: t });
    const bytes = Buffer.from(`${userLine('[Request interrupted by user] 中斷')}\n`, 'utf8');
    const cut = bytes.indexOf(Buffer.from('中', 'utf8')) + 1; // inside the 3-byte character
    appendFileSync(t, bytes.subarray(0, cut));
    tracker.poll();
    expect(tracker.list()).toHaveLength(1);
    appendFileSync(t, bytes.subarray(cut));
    tracker.poll();
    expect(tracker.list()).toEqual([]);
    tracker.close();
  });

  it('after a jump of more than 8 MB still finds an interrupt at the end', () => {
    const { tracker } = setup();
    const t = join(work, 't.jsonl');
    writeFileSync(t, '');
    tracker.start({ sessionId: SID, agent: 'claude', transcriptPath: t });
    const big = `${JSON.stringify({ type: 'attachment', data: 'x'.repeat(9 * 1024 * 1024) })}\n`;
    appendFileSync(t, `${big}${interruptLine}\n`);
    tracker.poll();
    expect(tracker.list()).toEqual([]);
    tracker.close();
  });

  it('ignores UNC, device, relative and non-jsonl transcript paths', () => {
    expect(acceptableTranscriptPath('\\\\host\\share\\t.jsonl')).toBeUndefined();
    expect(acceptableTranscriptPath('//host/share/t.jsonl')).toBeUndefined();
    expect(acceptableTranscriptPath('\\\\?\\C:\\t.jsonl')).toBeUndefined();
    expect(acceptableTranscriptPath('t.jsonl')).toBeUndefined();
    expect(acceptableTranscriptPath(join(work, 't.txt'))).toBeUndefined();
    expect(acceptableTranscriptPath(join(work, 't.jsonl'))).toBe(join(work, 't.jsonl'));
  });

  it('a missing transcript does not end the turn early', () => {
    const { tracker } = setup();
    tracker.start({ sessionId: SID, agent: 'claude', transcriptPath: join(work, 'missing.jsonl') });
    tracker.poll();
    expect(tracker.list()).toHaveLength(1);
    tracker.close();
  });
});

describe('activity routes', () => {
  const setup = (hardGate = false) => {
    const store = new UnitStore();
    const bus = new EventBus();
    const events: ServerEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const app = buildApp({ store, token: TOKEN, port: PORT, bus, config: { port: PORT, concurrency: 1, hardGate, runTimeoutMs: 1000 } });
    return { app, store, events };
  };
  const activity = async (app: ReturnType<typeof buildApp>) =>
    (await app.inject({ method: 'GET', url: '/api/activity', headers })).json();

  it('a prompt marks the session responding and its Stop clears it', async () => {
    const { app, events } = setup();
    const q = promptQuery(SID, { cwd: work, transcript_path: join(work, 't.jsonl'), prompt: 'explain the cache' });
    const res = await app.inject({ method: 'GET', url: `/api/hooks/claude/prompt?${q}`, headers });
    expect(res.json()).toEqual({ action: 'none' });
    expect(await activity(app)).toMatchObject([{ sessionId: SID, agent: 'claude', cwd: work, prompt: 'explain the cache' }]);
    expect(events).toEqual([{ type: 'activity.updated', sessionId: SID }]);

    const stop = await app.inject({
      method: 'POST',
      url: '/api/hooks/claude/stop',
      headers,
      payload: { session_id: SID, cwd: work, last_assistant_message: 'done' },
    });
    expect(await activity(app)).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(['activity.updated', 'activity.updated', 'unit.created']);
    expect(events[2]).toMatchObject({ unitId: stop.json().unitId });
    await app.close();
  });

  it('a blocked prompt does not start a turn', async () => {
    const { app, store } = setup(true);
    store.save({
      id: 'u1',
      agent: 'claude',
      sessionId: SID,
      cwd: work,
      createdAt: '2026-11-16T09:00:00.000Z',
      reply: { id: 'r', kind: 'reply', content: 'x', blocks: [] },
      files: [],
      threads: [
        {
          id: 't1',
          unitId: 'u1',
          anchor: { sourceId: 'r', blockId: 'b', quote: 'x' },
          status: 'draft',
          messages: [],
          createdAt: '2026-11-16T09:00:00.000Z',
        },
      ],
      status: 'open',
      delivered: false,
      warnings: [],
    } as never);
    const res = await app.inject({ method: 'GET', url: `/api/hooks/claude/prompt?session=${SID}`, headers });
    expect(res.json()).toMatchObject({ action: 'block' });
    expect(await activity(app)).toEqual([]);
    await app.close();
  });

  it('requires the token', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/api/activity', headers: { host: headers.host } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('promptQuery', () => {
  it('carries session, cwd, transcript and at most 200 prompt characters; skips missing fields', () => {
    const q = new URLSearchParams(promptQuery('s 1', { cwd: 'C:\\a b', transcript_path: 'C:\\t.jsonl', prompt: 'y'.repeat(500) }));
    expect(q.get('session')).toBe('s 1');
    expect(q.get('cwd')).toBe('C:\\a b');
    expect(q.get('transcript')).toBe('C:\\t.jsonl');
    expect(q.get('prompt')).toBe('y'.repeat(200));
    expect(promptQuery('s', { cwd: 5, prompt: '' })).toBe('session=s');
  });
});
