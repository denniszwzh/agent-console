export type AgentKind = 'claude' | 'codex';

export interface Block {
  id: string;
  kind: string;
  text: string;
  startLine: number;
  endLine: number;
  headingPath: string[];
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
  warnings: { at: string; threadId: string; paths: string[] }[];
}

export interface Config {
  port: number;
  concurrency: number;
  hardGate: boolean;
}
