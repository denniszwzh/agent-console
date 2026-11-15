import type { AgentKind, Anchor, ReviewUnit, Source, Thread } from '../shared/types.js';

export interface SessionSummary {
  sessionId: string;
  agent: AgentKind;
  cwd: string;
  lastActivity: string;
}

export interface ServerEvent {
  type: 'unit.created' | 'unit.updated';
  unitId: string;
  sessionId: string;
}

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
  units: (sessionId: string) => request<ReviewUnit[]>('GET', `/api/units?session=${enc(sessionId)}`),
  addThread: (unitId: string, anchor: Anchor, question: string, parentThreadId?: string) =>
    request<Thread>('POST', `/api/units/${enc(unitId)}/threads`, { anchor, question, parentThreadId }),
  deleteThread: (threadId: string) => request<void>('DELETE', `/api/threads/${enc(threadId)}`),
  sendDrafts: (unitId: string) => request<{ accepted: boolean }>('POST', `/api/units/${enc(unitId)}/send`),
  followUp: (threadId: string, text: string) => request<Thread>('POST', `/api/threads/${enc(threadId)}/messages`, { text }),
  retry: (threadId: string) => request<Thread>('POST', `/api/threads/${enc(threadId)}/retry`),
  resolve: (threadId: string) => request<Thread>('POST', `/api/threads/${enc(threadId)}/resolve`),
  setConclusion: (threadId: string, conclusion: string | null) =>
    request<Thread>('PUT', `/api/threads/${enc(threadId)}/conclusion`, { conclusion }),
  submit: (unitId: string) => request<{ bundle: string }>('POST', `/api/units/${enc(unitId)}/submit`),
  addFile: (unitId: string, path: string) => request<Source>('POST', `/api/units/${enc(unitId)}/files`, { path }),
};

export function imageUrl(unitId: string, path: string): string {
  return `/api/units/${enc(unitId)}/image?path=${enc(path)}`;
}

/** Subscribe to server events; EventSource reconnects on its own. Returns an unsubscribe function. */
export function subscribeEvents(onEvent: (e: ServerEvent) => void, onOpen?: () => void): () => void {
  const source = new EventSource('/api/events');
  source.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data) as ServerEvent);
    } catch (e) {
      console.warn('[events] ignoring malformed event', e);
    }
  };
  if (onOpen) source.onopen = onOpen;
  return () => source.close();
}
