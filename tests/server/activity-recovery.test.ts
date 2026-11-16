import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityTracker } from '../../src/server/activity.js';
import { openTurnIn, readOpenTurn, recoverActivity, type OpenTurn } from '../../src/server/activity-recovery.js';
import { EventBus } from '../../src/server/events.js';
import { UnitStore } from '../../src/server/store.js';
import type { ReviewUnit } from '../../src/shared/types.js';

const line = (o: unknown) => JSON.stringify(o);
const user = (text: string, at: string, extra: Record<string, unknown> = {}) =>
  line({ type: 'user', timestamp: at, message: { role: 'user', content: text }, ...extra });
const toolResult = (at: string) => line({ type: 'user', timestamp: at, message: { content: [{ type: 'tool_result', content: 'ok' }] } });
const assistant = (stop: string, at: string) =>
  line({ type: 'assistant', timestamp: at, message: { stop_reason: stop, content: [{ type: 'text', text: 'x' }] } });
const stopSummary = (at: string) => line({ type: 'system', subtype: 'stop_hook_summary', timestamp: at });
const peer = (at: string) =>
  user('Another Claude session sent a message: <agent-message from="abc">\n[Subagent hand-back] done</agent-message>', at, {
    isMeta: true,
    origin: { kind: 'peer' },
    promptSource: 'system',
  });
const codexEvent = (type: string, at: string, extra: Record<string, unknown> = {}) => line({ timestamp: at, type: 'event_msg', payload: { type, ...extra } });
const codexUser = (text: string, at: string) =>
  line({ timestamp: at, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });

describe('openTurnIn (Claude)', () => {
  it('finds a turn that started after the last one ended', () => {
    const lines = [
      user('first', '2026-11-16T01:00:00.000Z'),
      assistant('end_turn', '2026-11-16T01:01:00.000Z'),
      stopSummary('2026-11-16T01:01:01.000Z'),
      user('<system-reminder>\nnoise\n</system-reminder>\n修正錯誤', '2026-11-16T02:00:00.000Z'),
      assistant('tool_use', '2026-11-16T02:00:05.000Z'),
      toolResult('2026-11-16T02:00:06.000Z'),
      user('Base directory for this skill: C:\\x', '2026-11-16T02:00:07.000Z', { isMeta: true }),
      assistant('tool_use', '2026-11-16T02:00:08.000Z'),
    ];
    expect(openTurnIn('claude', lines)).toEqual({ since: '2026-11-16T02:00:00.000Z', prompt: '修正錯誤' });
  });

  it('a turn ended by the Stop record, end_turn or an interrupt is not open', () => {
    const start = user('go', '2026-11-16T02:00:00.000Z');
    expect(openTurnIn('claude', [start, assistant('tool_use', '2026-11-16T02:00:01.000Z'), stopSummary('2026-11-16T02:00:09.000Z')])).toBeUndefined();
    expect(openTurnIn('claude', [start, assistant('end_turn', '2026-11-16T02:00:01.000Z')])).toBeUndefined();
    expect(openTurnIn('claude', [start, assistant('tool_use', '2026-11-16T02:00:01.000Z'), user('[Request interrupted by user]', '2026-11-16T02:00:02.000Z')])).toBeUndefined();
  });

  it('a message from another session starts a turn, labelled', () => {
    const lines = [stopSummary('2026-11-16T01:00:00.000Z'), peer('2026-11-16T02:00:00.000Z'), assistant('tool_use', '2026-11-16T02:00:01.000Z')];
    expect(openTurnIn('claude', lines)).toEqual({ since: '2026-11-16T02:00:00.000Z', prompt: 'Message from another session' });
  });

  it('shell-mode, local command, compact and sidechain records do not start a turn', () => {
    const lines = [
      stopSummary('2026-11-16T01:00:00.000Z'),
      user('<bash-input>ls</bash-input>', '2026-11-16T02:00:00.000Z'),
      user('<bash-stdout>a</bash-stdout><bash-stderr></bash-stderr>', '2026-11-16T02:00:01.000Z'),
      user('<command-name>/compact</command-name>', '2026-11-16T02:00:02.000Z'),
      user('This session is being continued', '2026-11-16T02:00:03.000Z', { isCompactSummary: true }),
      user('<local-command-stdout>Compacted</local-command-stdout>', '2026-11-16T02:00:04.000Z'),
      user('side task', '2026-11-16T02:00:05.000Z', { isSidechain: true }),
    ];
    expect(openTurnIn('claude', lines)).toBeUndefined();
  });

  it('a window cut mid-turn with no end in it is open from its first record', () => {
    const lines = [assistant('tool_use', '2026-11-16T02:00:01.000Z'), toolResult('2026-11-16T02:00:02.000Z')];
    expect(openTurnIn('claude', lines, { cut: true })).toEqual({ since: '2026-11-16T02:00:01.000Z' });
    expect(openTurnIn('claude', lines)).toBeUndefined();
  });

  it('skips malformed lines', () => {
    expect(openTurnIn('claude', ['{"type":"user", broken', user('go', '2026-11-16T02:00:00.000Z')])).toEqual({ since: '2026-11-16T02:00:00.000Z', prompt: 'go' });
  });
});

describe('openTurnIn (Codex)', () => {
  it('a started task without completion is open, with its turn id and prompt', () => {
    const lines = [
      codexEvent('task_started', '2026-11-16T01:00:00.000Z', { turn_id: 't1' }),
      codexEvent('task_complete', '2026-11-16T01:01:00.000Z', { turn_id: 't1' }),
      codexEvent('task_started', '2026-11-16T02:00:00.000Z', { turn_id: 't2' }),
      codexUser('<environment_context>\n</environment_context>', '2026-11-16T02:00:00.100Z'),
      codexUser('整理 README', '2026-11-16T02:00:00.200Z'),
    ];
    expect(openTurnIn('codex', lines)).toEqual({ since: '2026-11-16T02:00:00.000Z', prompt: '整理 README', turnId: 't2' });
  });

  it('a completed or aborted task is not open', () => {
    const start = codexEvent('task_started', '2026-11-16T02:00:00.000Z', { turn_id: 't2' });
    expect(openTurnIn('codex', [start, codexEvent('task_complete', '2026-11-16T02:01:00.000Z')])).toBeUndefined();
    expect(openTurnIn('codex', [start, codexEvent('turn_aborted', '2026-11-16T02:01:00.000Z')])).toBeUndefined();
  });
});

describe('readOpenTurn', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ac-recover-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the end of the transcript', async () => {
    const f = join(dir, 't.jsonl');
    writeFileSync(f, `${[stopSummary('2026-11-16T01:00:00.000Z'), user('go', '2026-11-16T02:00:00.000Z'), assistant('tool_use', '2026-11-16T02:00:01.000Z')].join('\n')}\n`);
    expect(await readOpenTurn('claude', f)).toEqual({ since: '2026-11-16T02:00:00.000Z', prompt: 'go' });
  });

  it('reads only the tail of a large file, dropping the cut first line', async () => {
    const f = join(dir, 't.jsonl');
    const head = user('old prompt', '2026-11-16T00:00:00.000Z');
    writeFileSync(f, `${head}\n${'x'.repeat(5000)}\n${assistant('tool_use', '2026-11-16T02:00:01.000Z')}\n`);
    expect(await readOpenTurn('claude', f, 200)).toEqual({ since: '2026-11-16T02:00:01.000Z' });
  });

  it('a missing file has no open turn', async () => {
    expect(await readOpenTurn('claude', join(dir, 'nope.jsonl'))).toBeUndefined();
  });
});

describe('recoverActivity', () => {
  let home: string;
  let prev: string | undefined;
  const NOW = Date.parse('2026-11-16T02:10:00.000Z');

  beforeEach(() => {
    prev = process.env.AGENT_CONSOLE_HOME;
    home = mkdtempSync(join(tmpdir(), 'ac-recover-home-'));
    process.env.AGENT_CONSOLE_HOME = home;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.AGENT_CONSOLE_HOME;
    else process.env.AGENT_CONSOLE_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  });

  const unit = (sessionId: string, createdAt: string, agent: 'claude' | 'codex' = 'claude'): ReviewUnit => ({
    id: `u-${sessionId}`,
    agent,
    sessionId,
    cwd: `C:/w/${sessionId}`,
    createdAt,
    reply: { id: `r-${sessionId}`, kind: 'reply', content: 'x', blocks: [] },
    files: [],
    threads: [],
    status: 'open',
    delivered: false,
    warnings: [],
  });

  /** A transcript file last modified `agoMs` before NOW. */
  const transcript = (name: string, agoMs: number) => {
    const f = join(home, `${name}.jsonl`);
    writeFileSync(f, '{}\n');
    const t = new Date(NOW - agoMs);
    utimesSync(f, t, t);
    return f;
  };

  const setup = (turns: Record<string, OpenTurn | undefined>, files: Record<string, string>) => {
    const store = new UnitStore();
    const tracker = new ActivityTracker(new EventBus(), () => NOW);
    const read = vi.fn(async (_agent: string, file: string) => turns[file]);
    const locate = (_agent: string, sessionId: string) => files[sessionId];
    return { store, tracker, read, run: () => recoverActivity(store, tracker, locate, { now: () => NOW, read }) };
  };

  it('marks a session whose transcript has an open turn after its last reply as responding', async () => {
    const f = transcript('a', 60_000);
    const { store, tracker, run } = setup({ [f]: { since: '2026-11-16T02:04:40.000Z', prompt: 'Message from another session' } }, { a: f });
    store.save(unit('a', '2026-11-16T01:51:05.000Z'));
    expect(await run()).toBe(1);
    expect(tracker.list()).toEqual([
      {
        sessionId: 'a',
        agent: 'claude',
        cwd: 'C:/w/a',
        since: '2026-11-16T02:04:40.000Z',
        lastChange: new Date(NOW - 60_000).toISOString(),
        prompt: 'Message from another session',
      },
    ]);
    expect(tracker.transcriptPathFor('a')).toBe(f);
    tracker.close();
  });

  it('keeps the Codex turn id, so an interrupt for that turn ends it', async () => {
    const f = transcript('c', 1000);
    const { store, tracker, run } = setup({ [f]: { since: '2026-11-16T02:05:00.000Z', turnId: 't9' } }, { c: f });
    store.save(unit('c', '2026-11-16T01:00:00.000Z', 'codex'));
    await run();
    expect(tracker.end('c', 'other')).toBe(false);
    expect(tracker.end('c', 't9')).toBe(true);
    tracker.close();
  });

  it('leaves out turns not after the last reply, quiet transcripts, unknown transcripts and sessions already responding', async () => {
    const old = transcript('old', 2 * 60 * 60 * 1000);
    const done = transcript('done', 1000);
    const busy = transcript('busy', 1000);
    const turn = { since: '2026-11-16T02:00:00.000Z' };
    const { store, tracker, read, run } = setup({ [old]: turn, [done]: turn, [busy]: turn }, { old, done, busy });
    store.save(unit('old', '2026-11-16T01:00:00.000Z'));
    store.save(unit('done', '2026-11-16T02:00:00.000Z'));
    store.save(unit('busy', '2026-11-16T01:00:00.000Z'));
    store.save(unit('lost', '2026-11-16T01:00:00.000Z'));
    tracker.start({ sessionId: 'busy', agent: 'claude', prompt: 'live' });
    expect(await run()).toBe(0);
    expect(read).not.toHaveBeenCalledWith('claude', old);
    expect(tracker.list().map((a) => [a.sessionId, a.prompt])).toEqual([['busy', 'live']]);
    tracker.close();
  });
});

describe('ActivityTracker prompt preview', () => {
  it('labels messages from other sessions and background notices, and skips reminders', () => {
    const tracker = new ActivityTracker(new EventBus(), () => 0);
    const preview = (prompt: string) => {
      tracker.start({ sessionId: 's', agent: 'claude', prompt });
      return tracker.list()[0].prompt;
    };
    expect(preview('<agent-message from="abc">\n[Subagent hand-back] done')).toBe('Message from another session');
    expect(preview('Another Claude session sent a message: <agent-message from="abc">')).toBe('Message from another session');
    expect(preview('<task-notification>\n<task-id>1</task-id>')).toBe('Background task finished');
    expect(preview('<system-reminder>\nx\n</system-reminder>\n修正錯誤')).toBe('修正錯誤');
    expect(preview('<pasted_content id="1">\n貼上的需求\n</pasted_content>')).toBe('貼上的需求');
    tracker.close();
  });

  it('a recovered turn keeps its own start and last change', () => {
    const tracker = new ActivityTracker(new EventBus(), () => Date.parse('2026-11-16T02:10:00.000Z'));
    tracker.start({ sessionId: 's', agent: 'claude', since: '2026-11-16T02:04:40.000Z', lastChangeMs: Date.parse('2026-11-16T02:09:00.000Z') });
    expect(tracker.list()[0]).toMatchObject({ since: '2026-11-16T02:04:40.000Z', lastChange: '2026-11-16T02:09:00.000Z' });
    expect(tracker.startedAt('s')).toBe(Date.parse('2026-11-16T02:04:40.000Z'));
    tracker.close();
  });
});
