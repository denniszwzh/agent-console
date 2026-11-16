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
  /**
   * Set when the file is not in the agent's own edit records but was found by the end-of-turn scan
   * ('git': changed in `git status` since the turn started; 'mtime': modified since the turn started
   * in a folder without git, so it may not be the agent's change).
   */
  detectedBy?: 'git' | 'mtime';
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
  /** Absolute path of the conclusion bundle file (set at submit; the UI offers it as a fallback). */
  conclusionsPath?: string;
  /** Codex only: how a submitted unit was handed back (set at submit). */
  delivery?: { queued: boolean; instruction: string };
  warnings: { at: string; threadId: string; paths: string[] }[];
  /** Set when the end-of-turn scan left files out (over the per-turn cap) or did not finish its walk. */
  scanNotice?: { omitted: number; incomplete: boolean };
  /** The agent's transcript (Claude) or rollout (Codex) as reported by the Stop hook; used to read the session name. */
  transcriptPath?: string;
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
  /** The agent's own session name, or the first prompt when it has none (see titleSource). */
  title?: string;
  titleSource?: 'agent' | 'prompt';
  /** When the session started (first transcript record). */
  createdAt?: string;
  /** Last time the session's transcript changed. */
  lastModified?: string;
}

/** A main session that is working on a turn right now (GET /api/activity). */
export interface SessionActivity {
  sessionId: string;
  agent: AgentKind;
  /** Working directory reported by the prompt hook ('' if unknown). */
  cwd: string;
  /** When the user sent the prompt (ISO time). */
  since: string;
  /** Last time the session's transcript grew (ISO time); equals `since` until it does. */
  lastChange: string;
  /** First line of the prompt, shortened. */
  prompt?: string;
}

/** Notification pushed over SSE (GET /api/events); clients refetch on receipt. */
export type ServerEvent =
  | { type: 'unit.created' | 'unit.updated'; unitId: string; sessionId: string }
  | { type: 'activity.updated'; sessionId: string };
