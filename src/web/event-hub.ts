import type { ServerEvent } from '../shared/types.js';

/**
 * One server-event connection for all tabs of the panel.
 *
 * Each tab holding an EventSource keeps one HTTP/1.1 connection open, and the browser allows only six
 * per host: with six tabs open, every other request to the panel waits forever. So the tabs elect one
 * holder with a Web Lock; it opens the only EventSource and relays every event over a BroadcastChannel.
 * When it closes, the lock passes to a waiting tab, which connects in its place.
 *
 * `onOpen` keeps its single-tab meaning for every tab: the first call says "connected", any later call
 * says "reconnected, events may have been missed".
 */

export interface SourceLike {
  onmessage: ((msg: { data: string }) => void) | null;
  onopen: (() => void) | null;
  /** Fires on every failure; the browser keeps reconnecting unless `readyState` is CLOSED. */
  onerror?: (() => void) | null;
  readonly readyState?: number;
  close(): void;
}

/** EventSource.CLOSED: the server refused the stream (for example 401) and the browser gave up. */
const CLOSED = 2;

export interface ChannelLike {
  onmessage: ((msg: { data: unknown }) => void) | null;
  postMessage(data: unknown): void;
  close(): void;
}

export interface HubDeps {
  openSource(url: string): SourceLike;
  /** BroadcastChannel; without it (or `lock`) each tab connects on its own. */
  channel?(name: string): ChannelLike;
  /** navigator.locks.request: runs `task` while holding the lock; an aborted signal withdraws the request. */
  lock?(name: string, signal: AbortSignal, task: () => Promise<void>): Promise<unknown>;
}

type Relay =
  | { kind: 'event'; event: ServerEvent }
  /** The shared connection (re)opened. */
  | { kind: 'open' }
  /** A tab asks whether the shared connection is open. */
  | { kind: 'hello' }
  /** Answer to hello: it is. */
  | { kind: 'ack' }
  /** The holder's stream ended for good (the server refused it); nobody should expect events. */
  | { kind: 'closed' };

const NAME = 'agent-console.events';
const URL = '/api/events';

function parseEvent(data: string): ServerEvent | undefined {
  try {
    return JSON.parse(data) as ServerEvent;
  } catch (e) {
    console.warn('[events] ignoring malformed event', e);
    return undefined;
  }
}

function subscribeDirect(
  onEvent: (e: ServerEvent) => void,
  onOpen: (() => void) | undefined,
  deps: HubDeps,
  onClosed: (() => void) | undefined,
): () => void {
  const source = deps.openSource(URL);
  source.onmessage = (msg) => {
    const e = parseEvent(msg.data);
    if (e) onEvent(e);
  };
  if (onOpen) source.onopen = onOpen;
  source.onerror = () => {
    if (source.readyState !== CLOSED) return;
    source.close();
    onClosed?.();
  };
  return () => source.close();
}

/**
 * `onClosed` runs when the shared connection ends for good (the server refused it, e.g. the session expired).
 * There is no reconnect loop: the holder closes the stream and releases the lock, so a tab that signs in
 * again can take over.
 */
export function subscribeShared(
  onEvent: (e: ServerEvent) => void,
  onOpen: (() => void) | undefined,
  deps: HubDeps,
  onClosed?: () => void,
): () => void {
  if (!deps.channel || !deps.lock) return subscribeDirect(onEvent, onOpen, deps, onClosed);
  const channel = deps.channel(NAME);
  const abort = new AbortController();
  let closed = false;
  let connected = false;
  let source: SourceLike | null = null;
  let sourceOpen = false;
  let release: (() => void) | null = null;

  const opened = () => {
    connected = true;
    onOpen?.();
  };

  channel.onmessage = ({ data }) => {
    const msg = data as Relay;
    if (source) {
      // This tab holds the connection: only newcomers' questions concern it.
      if (msg.kind === 'hello' && sourceOpen) channel.postMessage({ kind: 'ack' } satisfies Relay);
      return;
    }
    if (msg.kind === 'event') onEvent(msg.event);
    else if (msg.kind === 'open') opened();
    else if (msg.kind === 'ack' && !connected) opened();
    else if (msg.kind === 'closed') {
      // Over for every tab: stop waiting for the lock, so no tab retries a stream the server refuses.
      closed = true;
      abort.abort();
      onClosed?.();
    }
  };
  channel.postMessage({ kind: 'hello' } satisfies Relay);

  deps
    .lock(NAME, abort.signal, () => {
      if (closed) return Promise.resolve();
      return new Promise<void>((resolve) => {
        release = resolve;
        const s = deps.openSource(URL);
        source = s;
        s.onmessage = (msg) => {
          const e = parseEvent(msg.data);
          if (!e) return;
          onEvent(e);
          channel.postMessage({ kind: 'event', event: e } satisfies Relay);
        };
        s.onopen = () => {
          sourceOpen = true;
          opened();
          channel.postMessage({ kind: 'open' } satisfies Relay);
        };
        s.onerror = () => {
          if (s.readyState !== CLOSED) return;
          s.close();
          source = null;
          sourceOpen = false;
          closed = true;
          channel.postMessage({ kind: 'closed' } satisfies Relay);
          onClosed?.();
          // Let the other tabs hear 'closed' (and leave) before the lock passes on, or the next one would retry.
          setTimeout(resolve, 0);
        };
      });
    })
    .catch(() => {
      // Withdrawn (this tab closed while waiting) or the lock is unavailable.
    });

  return () => {
    closed = true;
    abort.abort();
    source?.close();
    source = null;
    channel.close();
    release?.();
  };
}

/** The browser's EventSource, BroadcastChannel and Web Locks, where they exist. */
export function browserHubDeps(): HubDeps {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  const shared = typeof BroadcastChannel === 'function' && locks && typeof locks.request === 'function';
  return {
    // The handlers set here read only `data`, which every MessageEvent has.
    openSource: (url) => new EventSource(url) as unknown as SourceLike,
    ...(shared
      ? {
          channel: (name: string) => new BroadcastChannel(name) as unknown as ChannelLike,
          lock: (name: string, signal: AbortSignal, task: () => Promise<void>) => locks.request(name, { signal }, task),
        }
      : {}),
  };
}
