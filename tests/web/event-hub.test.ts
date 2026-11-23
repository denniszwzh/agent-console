import { describe, expect, it, vi } from 'vitest';
import { subscribeShared, type ChannelLike, type HubDeps, type SourceLike } from '../../src/web/event-hub.js';
import type { ServerEvent } from '../../src/shared/types.js';

/** Lets relayed messages settle (a question and its answer are two hops). */
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

/** One browser: a lock manager, broadcast channels and event sources shared by every "tab" made from it. */
function browser() {
  const sources: (SourceLike & { emit: (data: string) => void; open: () => void; fail: (readyState: number) => void; closed: boolean })[] = [];
  const channels = new Set<ChannelLike & { name: string }>();
  const queue: { signal: AbortSignal; task: () => Promise<void>; done: (v?: unknown) => void }[] = [];
  let held = false;
  const grant = () => {
    if (held) return;
    const next = queue.shift();
    if (!next) return;
    if (next.signal.aborted) return grant();
    held = true;
    void next.task().then(() => {
      held = false;
      next.done();
      grant();
    });
  };
  const deps: HubDeps = {
    openSource: () => {
      const s = {
        onmessage: null as SourceLike['onmessage'],
        onopen: null as SourceLike['onopen'],
        onerror: null as SourceLike['onerror'],
        readyState: 1,
        closed: false,
        close() {
          s.closed = true;
        },
        emit(data: string) {
          s.onmessage?.({ data });
        },
        open() {
          s.onopen?.();
        },
        fail(readyState: number) {
          s.readyState = readyState;
          s.onerror?.();
        },
      };
      sources.push(s);
      return s;
    },
    channel: (name) => {
      const c = {
        name,
        onmessage: null as ChannelLike['onmessage'],
        postMessage(data: unknown) {
          // Like BroadcastChannel: async, and never to the sender.
          for (const other of channels) if (other !== c && other.name === name) setTimeout(() => other.onmessage?.({ data }), 0);
        },
        close() {
          channels.delete(c);
        },
      };
      channels.add(c);
      return c;
    },
    lock: (_name, signal, task) =>
      new Promise((done) => {
        queue.push({ signal, task, done });
        grant();
      }),
  };
  return { deps, sources };
}

const ev = (sessionId: string): ServerEvent => ({ type: 'unit.created', unitId: `u-${sessionId}`, sessionId });

function tab(deps: HubDeps) {
  const events: ServerEvent[] = [];
  const onOpen = vi.fn();
  const stop = subscribeShared((e) => events.push(e), onOpen, deps);
  return { events, onOpen, stop };
}

describe('subscribeShared', () => {
  it('a stream the server refuses for good is closed, the lock released, and every tab told once', async () => {
    const { deps, sources } = browser();
    const closedA = vi.fn();
    const closedB = vi.fn();
    const a = subscribeShared(() => {}, undefined, deps, closedA);
    const b = subscribeShared(() => {}, undefined, deps, closedB);
    await flush();
    sources[0].open();
    // A transient error (the browser is reconnecting) is not the end.
    sources[0].fail(0);
    await flush();
    expect(closedA).not.toHaveBeenCalled();
    sources[0].fail(2);
    await flush();
    expect(sources[0].closed).toBe(true);
    expect(closedA).toHaveBeenCalledTimes(1);
    expect(closedB).toHaveBeenCalledTimes(1);
    // No reconnect loop: the waiting tab did not open a new connection.
    expect(sources).toHaveLength(1);
    a();
    b();
  });

  it('only one tab opens a connection; every tab gets its events', async () => {
    const { deps, sources } = browser();
    const a = tab(deps);
    const b = tab(deps);
    await flush();
    expect(sources).toHaveLength(1);
    sources[0].emit(JSON.stringify(ev('s1')));
    await flush();
    expect(a.events).toEqual([ev('s1')]);
    expect(b.events).toEqual([ev('s1')]);
  });

  it('a tab that joins an open connection is told it is connected, without a resync anywhere', async () => {
    const { deps, sources } = browser();
    const a = tab(deps);
    await flush();
    sources[0].open();
    const b = tab(deps);
    await flush();
    const c = tab(deps);
    await flush();
    expect(a.onOpen).toHaveBeenCalledTimes(1);
    expect(b.onOpen).toHaveBeenCalledTimes(1);
    expect(c.onOpen).toHaveBeenCalledTimes(1);
  });

  it('when the connected tab closes, the next one connects and every tab resyncs', async () => {
    const { deps, sources } = browser();
    const a = tab(deps);
    await flush();
    sources[0].open();
    const b = tab(deps);
    const c = tab(deps);
    await flush();
    a.stop();
    await flush();
    expect(sources[0].closed).toBe(true);
    expect(sources).toHaveLength(2);
    sources[1].open();
    await flush();
    // A second "open" is what makes the panel refetch what it may have missed.
    expect(b.onOpen).toHaveBeenCalledTimes(2);
    expect(c.onOpen).toHaveBeenCalledTimes(2);
    sources[1].emit(JSON.stringify(ev('s2')));
    await flush();
    expect(b.events).toEqual([ev('s2')]);
    expect(c.events).toEqual([ev('s2')]);
  });

  it('a reconnect of the shared connection reaches every tab', async () => {
    const { deps, sources } = browser();
    const a = tab(deps);
    await flush();
    sources[0].open();
    const b = tab(deps);
    await flush();
    sources[0].open();
    await flush();
    expect(a.onOpen).toHaveBeenCalledTimes(2);
    expect(b.onOpen).toHaveBeenCalledTimes(2);
  });

  it('a waiting tab that closes gives up its turn', async () => {
    const { deps, sources } = browser();
    const a = tab(deps);
    const b = tab(deps);
    await flush();
    b.stop();
    a.stop();
    await flush();
    expect(sources).toHaveLength(1);
  });

  it('ignores malformed events', async () => {
    const { deps, sources } = browser();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = tab(deps);
    const b = tab(deps);
    await flush();
    sources[0].emit('{not json');
    await flush();
    expect(a.events).toEqual([]);
    expect(b.events).toEqual([]);
    warn.mockRestore();
  });

  it('without locks or channels each tab opens its own connection', async () => {
    const { deps, sources } = browser();
    const plain: HubDeps = { openSource: deps.openSource };
    const a = tab(plain);
    tab(plain);
    expect(sources).toHaveLength(2);
    sources[0].open();
    sources[0].emit(JSON.stringify(ev('s1')));
    expect(a.onOpen).toHaveBeenCalledTimes(1);
    expect(a.events).toEqual([ev('s1')]);
    a.stop();
    expect(sources[0].closed).toBe(true);
  });
});
