import type { ReviewUnit, Thread } from '../shared/types.js';
import { firstLine } from './labels.js';

/** Something that finished while the panel was open: a main-session reply, or a thread's answer. */
export interface Completion {
  /** Stable per finished item: a later completion with the same key replaces the earlier card. */
  key: string;
  kind: 'reply' | 'thread';
  sessionId: string;
  unitId: string;
  threadId?: string;
  /** The thread run ended in an error instead of an answer. */
  failed?: boolean;
  /** One line saying what finished (the prompt or the question). */
  text: string;
  /** When it was noticed (ms since epoch). */
  at: number;
}

/** Where a notification leads when clicked. */
export interface FocusTarget {
  unitId: string;
  threadId?: string;
  /** Increases on every request, so asking for the same place twice still moves there. */
  seq: number;
}

/** The newest user message of a thread (a follow-up, else the original question). */
function latestQuestion(thread: Thread): string {
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    if (thread.messages[i].role === 'user') return thread.messages[i].content;
  }
  return '';
}

function replyText(unit: ReviewUnit): string {
  const prompts = unit.prompts?.filter((p) => !p.delivery) ?? [];
  const last = prompts[prompts.length - 1];
  if (last) return firstLine(last.text, 80);
  return firstLine(unit.reply.content, 80);
}

/**
 * What finished between two loads of one session's units. Nothing is reported for the first load
 * (`prev` undefined), nor for thread runs that are part of integrating conclusions.
 */
export function detectCompletions(prev: ReviewUnit[] | undefined, next: ReviewUnit[], now = Date.now()): Completion[] {
  if (!prev) return [];
  const before = new Map(prev.map((u) => [u.id, u]));
  const out: Completion[] = [];
  for (const unit of next) {
    const old = before.get(unit.id);
    if (!old) {
      out.push({ key: `reply:${unit.id}`, kind: 'reply', sessionId: unit.sessionId, unitId: unit.id, text: replyText(unit), at: now });
      continue;
    }
    // Conclusion runs reuse the 'answering' status; their results are not answers to read.
    if (old.integrating || unit.integrating) continue;
    const oldThreads = new Map(old.threads.map((t) => [t.id, t]));
    for (const t of unit.threads) {
      // Usually seen while answering; a run that ended within one refresh may have been seen only as a draft or not at all.
      const was = oldThreads.get(t.id)?.status;
      if (was !== undefined && was !== 'answering' && was !== 'draft') continue;
      if (t.status !== 'awaiting' && t.status !== 'error') continue;
      out.push({
        key: `thread:${t.id}`,
        kind: 'thread',
        sessionId: unit.sessionId,
        unitId: unit.id,
        threadId: t.id,
        failed: t.status === 'error' || undefined,
        text: firstLine(latestQuestion(t), 80),
        at: now,
      });
    }
  }
  return out;
}

/** Adds new completions on top of the stack; one card per key, the newest version kept. */
export function stackCompletions(stack: Completion[], added: Completion[]): Completion[] {
  if (added.length === 0) return stack;
  const keys = new Set(added.map((c) => c.key));
  return [...stack.filter((c) => !keys.has(c.key)), ...added];
}

/** The thread and every thread it hangs under, innermost first. */
export function threadChain(unit: ReviewUnit, threadId: string): string[] {
  const byId = new Map(unit.threads.map((t) => [t.id, t]));
  const chain: string[] = [];
  let id: string | null = threadId;
  while (id && !chain.includes(id)) {
    const t = byId.get(id);
    if (!t) break;
    chain.push(id);
    id = t.parentThreadId;
  }
  return chain;
}
