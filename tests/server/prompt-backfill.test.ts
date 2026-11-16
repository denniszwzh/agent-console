import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../../src/server/events.js';
import { PromptBackfill } from '../../src/server/prompt-backfill.js';
import { UnitStore } from '../../src/server/store.js';
import type { PromptReader } from '../../src/server/turn-prompts.js';
import type { ReviewUnit, ServerEvent, Thread, TurnPrompt } from '../../src/shared/types.js';

let home: string;
let prev: string | undefined;
beforeEach(() => {
  prev = process.env.AGENT_CONSOLE_HOME;
  home = mkdtempSync(join(tmpdir(), 'ac-backfill-'));
  process.env.AGENT_CONSOLE_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.AGENT_CONSOLE_HOME;
  else process.env.AGENT_CONSOLE_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

function unit(id: string, createdAt: string, over: Partial<ReviewUnit> = {}): ReviewUnit {
  return {
    id,
    agent: 'claude',
    sessionId: 's1',
    cwd: 'C:/w',
    createdAt,
    reply: { id: `r-${id}`, kind: 'reply', content: 'x', blocks: [] },
    files: [],
    threads: [],
    status: 'stale',
    delivered: false,
    warnings: [],
    ...over,
  };
}

const p = (text: string, at: string): TurnPrompt => ({ text, at });
const TRANSCRIPT = [p('a1', '2026-11-16T00:30:00.000Z'), p('a2', '2026-11-16T00:50:00.000Z'), p('b', '2026-11-16T01:30:00.000Z'), p('c', '2026-11-16T02:30:00.000Z')];

function setup(read: PromptReader, locate: () => string | undefined = () => 'C:/t.jsonl') {
  const store = new UnitStore();
  store.save(unit('u1', '2026-11-16T01:00:00.000Z'));
  store.save(unit('u2', '2026-11-16T02:00:00.000Z'));
  store.save(unit('u3', '2026-11-16T03:00:00.000Z', { status: 'open' }));
  const bus = new EventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((e) => events.push(e));
  return { store, events, backfill: new PromptBackfill(store, bus, locate, read) };
}

const texts = (store: UnitStore, id: string) => store.get(id)!.prompts?.map((x) => x.text);

describe('PromptBackfill', () => {
  it('fills prompts per turn from one transcript read', async () => {
    let reads = 0;
    const { store, events, backfill } = setup(async () => {
      reads++;
      return TRANSCRIPT;
    });
    expect(await backfill.runOnce()).toBe(3);
    expect(reads).toBe(1);
    expect(texts(store, 'u1')).toEqual(['a2']);
    expect(texts(store, 'u2')).toEqual(['b']);
    expect(texts(store, 'u3')).toEqual(['c']);
    expect(events.filter((e) => e.type === 'unit.updated')).toHaveLength(3);
  });

  it('marks units [] when the transcript is missing', async () => {
    const { store, backfill } = setup(async () => TRANSCRIPT, () => undefined);
    await backfill.runOnce();
    expect(texts(store, 'u1')).toEqual([]);
    expect(texts(store, 'u3')).toEqual([]);
  });

  it('leaves units untouched when the transcript is unreadable', async () => {
    const { store, events, backfill } = setup(async () => null);
    expect(await backfill.runOnce()).toBe(0);
    expect(store.get('u1')!.prompts).toBeUndefined();
    expect(events).toEqual([]);
  });

  it('skips units that already have prompts', async () => {
    const { store, backfill } = setup(async () => TRANSCRIPT);
    const u2 = store.get('u2')!;
    u2.prompts = [p('kept', '2026-11-16T01:59:00.000Z')];
    store.save(u2);
    expect(await backfill.runOnce()).toBe(2);
    expect(texts(store, 'u2')).toEqual(['kept']);
  });

  it('keeps thread changes made while the transcript was being read', async () => {
    const thread = { id: 't1', unitId: 'u1', status: 'awaiting' } as Thread;
    let store!: UnitStore;
    const ctx = setup(async () => {
      const u1 = store.get('u1')!;
      u1.threads = [thread];
      store.save(u1);
      return TRANSCRIPT;
    });
    store = ctx.store;
    await ctx.backfill.runOnce();
    expect(store.get('u1')!.threads.map((t) => t.id)).toEqual(['t1']);
    expect(texts(store, 'u1')).toEqual(['a2']);
  });

  it('does nothing on a second run', async () => {
    const { backfill } = setup(async () => TRANSCRIPT);
    await backfill.runOnce();
    expect(await backfill.runOnce()).toBe(0);
  });
});
