export type AgentKind = 'claude' | 'codex';

export interface Block {
  id: string;
  kind: string;
  text: string;
  startLine: number;
  endLine: number;
  headingPath: string[];
  /** Number of an ordered list item within its list (items are split into separate blocks). */
  ordinal?: number;
}

export interface Source {
  id: string;
  kind: 'reply' | 'file';
  path?: string;
  content: string;
  blocks: Block[];
  language?: string;
  binary?: boolean;
  image?: boolean;
  truncated?: boolean;
  error?: string;
}

// sourceId is 'msg:<messageId>' for anchors on an answer.
export interface Anchor {
  sourceId: string;
  blockId: string;
  quote: string;
  headingPath: string[];
  startLine: number;
  endLine: number;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  blocks?: Block[];
}

export type ThreadStatus = 'draft' | 'answering' | 'awaiting' | 'resolved' | 'error' | 'expired';

export interface Thread {
  id: string;
  unitId: string;
  parentThreadId: string | null;
  anchor: Anchor;
  forkFromSessionId: string;
  sessionId: string | null;
  status: ThreadStatus;
  messages: Message[];
  conclusion: string | null;
  noConclusion: boolean;
  error?: string;
}

export type UnitStatus = 'open' | 'submitted' | 'stale';

export interface ReviewUnit {
  id: string;
  agent: AgentKind;
  sessionId: string;
  cwd: string;
  createdAt: string;
  reply: Source;
  files: Source[];
  threads: Thread[];
  status: UnitStatus;
  delivered: boolean;
  /** Codex only: how a submitted unit was handed back (set at submit). */
  delivery?: { queued: boolean; instruction: string };
  warnings: { at: string; threadId: string; paths: string[] }[];
}

export interface Config {
  port: number;
  concurrency: number;
  hardGate: boolean;
  /** Upper bound for one fork run (answer or conclusion), in milliseconds. */
  runTimeoutMs: number;
}

/** One row of the session list (GET /api/sessions). */
export interface SessionSummary {
  sessionId: string;
  agent: AgentKind;
  cwd: string;
  lastActivity: string;
}

/** Notification pushed over SSE (GET /api/events); clients refetch on receipt. */
export interface ServerEvent {
  type: 'unit.created' | 'unit.updated';
  unitId: string;
  sessionId: string;
}
