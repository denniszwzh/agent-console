import fs from 'node:fs';
import readline from 'node:readline';
import { isCodexInstruction } from '../agents/codex.js';
import type { AgentKind, TurnPrompt } from '../shared/types.js';

/** Prompts kept per turn; earlier ones in the same window are only counted. */
export const MAX_TURN_PROMPTS = 5;

/**
 * Tags the agents (or their hosts) put into user messages themselves. A message that starts with one of
 * them is not something the user typed. Typed prompts can start with `<` too (pasted content in the
 * desktop app is wrapped in `<pasted_content>`), so this is a list, not a "starts with <" rule.
 */
export const INJECTED_TAGS = [
  'system-reminder',
  'task-notification',
  'command-name',
  'command-message',
  'command-args',
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
  'environment_context',
  'turn_aborted',
  'subagent_notification',
  'skill',
  'user_instructions',
  'bash-input',
  'bash-stdout',
  'bash-stderr',
  'ide_opened_file',
  'ide_selection',
  'ide_diagnostics',
  'user-memory-input',
];
const INJECTED_START = new RegExp(`^<(?:${INJECTED_TAGS.join('|')})[\\s>]`);
const INJECTED_PREFIXES = ['[Request interrupted by user', '# AGENTS.md instructions'];
const REMINDER_BLOCK = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const PASTED_TAG = /<\/?pasted_content(?:\s[^>]*)?>/g;

/**
 * The part of a user message the user wrote: reminder blocks removed, pasted-content wrappers unwrapped,
 * trimmed. Undefined for empty text and for messages the agent or its host injected.
 */
export function cleanPromptText(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined;
  const t = text.replace(REMINDER_BLOCK, '').trim();
  if (!t || INJECTED_START.test(t) || INJECTED_PREFIXES.some((p) => t.startsWith(p))) return undefined;
  const unwrapped = t.replace(PASTED_TAG, '').replace(/\n{3,}/g, '\n\n').trim();
  return unwrapped || undefined;
}

export function isInjectedPrompt(text: string): boolean {
  return cleanPromptText(text) === undefined;
}

type Rec = Record<string, any>;

/** Claude user records that do not carry a prompt the user typed (meta, sidechain, summaries, other senders). */
export function isSkippedClaudeRecord(rec: Rec): boolean {
  if (rec.isMeta === true || rec.isSidechain === true || rec.isCompactSummary === true || rec.isVisibleInTranscriptOnly === true) return true;
  const origin = rec.origin as Rec | undefined;
  if (origin && typeof origin === 'object' && typeof origin.kind === 'string' && origin.kind !== 'human') return true;
  return rec.promptSource === 'system';
}

/** Text parts of a message content (a string or typed parts); undefined when it holds tool results. */
export function userTextParts(content: unknown, partType: string): string[] | undefined {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return undefined;
  if (content.some((c) => (c as Rec)?.type === 'tool_result')) return undefined;
  return content.filter((c) => (c as Rec)?.type === partType).map((c) => String((c as Rec).text ?? ''));
}

function promptOf(parts: string[] | undefined, at: unknown): TurnPrompt | undefined {
  if (typeof at !== 'string') return undefined;
  const texts = (parts ?? []).map(cleanPromptText).filter((t): t is string => t !== undefined);
  if (texts.length === 0) return undefined;
  const text = texts.join('\n\n');
  return isCodexInstruction(text) ? { text, at, delivery: true } : { text, at };
}

function claudePrompt(rec: Rec): TurnPrompt | undefined {
  if (rec.type !== 'user' || isSkippedClaudeRecord(rec)) return undefined;
  return promptOf(userTextParts(rec.message?.content, 'text'), rec.timestamp);
}

function codexPrompt(rec: Rec): TurnPrompt | undefined {
  const p = rec.payload as Rec | undefined;
  if (rec.type !== 'response_item' || p?.type !== 'message' || p.role !== 'user') return undefined;
  return promptOf(userTextParts(p.content, 'input_text'), rec.timestamp);
}

/** Reads a transcript's user prompts. [] when the file is missing; null when it could not be read. */
export type PromptReader = (agent: AgentKind, file: string) => Promise<TurnPrompt[] | null>;

/**
 * Every prompt the user typed in a Claude transcript or Codex rollout, in file order. The file is read
 * line by line (transcripts can be tens of MB); lines that cannot hold a user message are not parsed.
 * Never throws.
 */
export const readUserPrompts: PromptReader = async (agent, file) => {
  const marker = agent === 'claude' ? '"type":"user"' : '"role":"user"';
  const pick = agent === 'claude' ? claudePrompt : codexPrompt;
  const prompts: TurnPrompt[] = [];
  let stream: fs.ReadStream;
  try {
    stream = fs.createReadStream(file, { encoding: 'utf8' });
  } catch {
    return null;
  }
  try {
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.includes(marker)) continue;
      let rec: unknown;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (!rec || typeof rec !== 'object') continue;
      const prompt = pick(rec as Rec);
      if (prompt) prompts.push(prompt);
    }
    return prompts;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
  } finally {
    stream.destroy();
  }
};

/**
 * The prompts that led to one reply: those after the previous reply (`after`, exclusive) up to this
 * reply (`upTo`, inclusive), compared as times. The first reply of a session (`after` undefined) gets
 * only the last prompt before it, so history from before the console tracked the session stays out.
 * At most MAX_TURN_PROMPTS are kept, the newest; the rest are counted in `omitted`.
 */
export function promptsInWindow(all: TurnPrompt[], after: string | undefined, upTo: string): { prompts: TurnPrompt[]; omitted: number } {
  const end = Date.parse(upTo);
  const start = after === undefined ? -Infinity : Date.parse(after);
  const inside = all.filter((p) => {
    const t = Date.parse(p.at);
    return !Number.isNaN(t) && t > start && t <= end;
  });
  if (after === undefined) return { prompts: inside.slice(-1), omitted: 0 };
  const prompts = inside.slice(-MAX_TURN_PROMPTS);
  return { prompts, omitted: inside.length - prompts.length };
}
