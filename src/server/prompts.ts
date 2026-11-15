import type { Anchor } from '../shared/types.js';

/**
 * Prompt for the first message of a review thread. The thread runs as a forked,
 * read-only side branch of the main session.
 */
export function questionPrompt(anchor: Anchor, sourceLabel: string, question: string): string {
  const quoted = anchor.quote
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join('\n');
  const range = `lines ${anchor.startLine}–${anchor.endLine}`;
  const heading = anchor.headingPath.length ? ` § ${anchor.headingPath.join(' > ')}` : '';
  const where = sourceLabel === 'agent reply' ? sourceLabel : `${sourceLabel}${heading} ${range}`;
  return [
    'You are answering a read-only side-branch review question about work done in this session.',
    'Do NOT modify, create or delete any files, and do not run commands that change state. Only read and explain.',
    '',
    `Source: ${where}`,
    'Quoted text under review:',
    quoted,
    '',
    'Question:',
    question,
    '',
    'Answer in the same language the question above is written in.',
  ].join('\n');
}

/** Prompt that asks the thread's agent to distill the thread into a one-line conclusion. */
export function conclusionPrompt(childConclusions: string[]): string {
  const lines = [
    'This read-only review thread is now being closed. Do NOT modify any files.',
    'Write the conclusion of this thread as exactly ONE line, with no preamble, in the language the user used in this thread.',
    'The line must state one of: a decision, a requested change, or "clarification only, no change needed".',
  ];
  if (childConclusions.length) {
    lines.push('', 'Take the conclusions of the follow-up sub-threads into account:');
    childConclusions.forEach((c, i) => lines.push(`${i + 1}. ${c}`));
  }
  return lines.join('\n');
}
