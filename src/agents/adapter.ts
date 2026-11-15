import type { AgentKind } from '../shared/types.js';

export interface RunRequest {
  parentSessionId: string;
  fork: boolean;
  prompt: string;
  cwd: string;
}

export type AgentEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'text'; text: string } // full text of one assistant message
  | { type: 'done'; finalText: string }
  | { type: 'error'; message: string };

export interface AgentAdapter {
  kind: AgentKind;
  run(req: RunRequest, signal?: AbortSignal): AsyncIterable<AgentEvent>;
}
