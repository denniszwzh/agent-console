import type { Anchor, ReviewUnit, ServerEvent, SessionActivity, SessionSummary, Source, Thread } from '../shared/types.js';
import { browserHubDeps, subscribeShared } from './event-hub.js';

export type { ServerEvent, SessionActivity, SessionSummary };


export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// Auth is the HttpOnly ac_token cookie set by /auth; same-origin fetches send it.
async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const data = (await res.json()) as { error?: unknown };
      if (typeof data.error === 'string') message = data.error;
    } catch {
      /* keep the status text */
    }
    throw new ApiError(message, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

export const api = {
  sessions: () => request<SessionSummary[]>('GET', '/api/sessions'),
  activity: () => request<SessionActivity[]>('GET', '/api/activity'),
  units: (sessionId: string) => request<ReviewUnit[]>('GET', `/api/units?session=${enc(sessionId)}`),
  addThread: (unitId: string, anchor: Anchor, question: string, parentThreadId?: string) =>
    request<Thread>('POST', `/api/units/${enc(unitId)}/threads`, { anchor, question, parentThreadId }),
  deleteThread: (threadId: string) => request<void>('DELETE', `/api/threads/${enc(threadId)}`),
  sendThread: (threadId: string) => request<Thread>('POST', `/api/threads/${enc(threadId)}/send`),
  followUp: (threadId: string, text: string) => request<Thread>('POST', `/api/threads/${enc(threadId)}/messages`, { text }),
  retry: (threadId: string) => request<Thread>('POST', `/api/threads/${enc(threadId)}/retry`),
  integrate: (unitId: string) => request<{ accepted: boolean }>('POST', `/api/units/${enc(unitId)}/integrate`),
  addFile: (unitId: string, path: string) => request<Source>('POST', `/api/units/${enc(unitId)}/files`, { path }),
};

/** URL of a local image referenced by one source (reply, file id, or 'msg:<messageId>') of a unit. */
export function imageUrl(unitId: string, sourceId: string, path: string): string {
  return `/api/units/${enc(unitId)}/image?source=${enc(sourceId)}&path=${enc(path)}`;
}

/**
 * Subscribe to server events. All tabs share one connection (see event-hub); it reconnects on its own.
 * Returns an unsubscribe function.
 */
export function subscribeEvents(onEvent: (e: ServerEvent) => void, onOpen?: () => void): () => void {
  return subscribeShared(onEvent, onOpen, browserHubDeps());
}
