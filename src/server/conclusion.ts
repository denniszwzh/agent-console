import type { ReviewUnit, Thread } from '../shared/types.js';
import { carriedByAncestor } from '../shared/gate.js';

const QUOTE_LIMIT = 300;

function sourceLabel(unit: ReviewUnit, t: Thread): string {
  const id = t.anchor.sourceId;
  if (id.startsWith('msg:') || id === unit.reply.id) return 'Reply';
  const file = unit.files.find((f) => f.id === id);
  if (!file) return 'Unknown source';
  const hp = t.anchor.headingPath;
  const section = hp.length > 0 ? ` § ${hp.join(' > ')}` : '';
  return `${file.path ?? 'unknown file'}${section} (lines ${t.anchor.startLine}–${t.anchor.endLine})`;
}

/** Blockquote every line so untrusted text cannot forge bundle structure. */
function quoteLines(text: string): string {
  return text
    .split(/\r\n|[\r\n\u2028\u2029]/)
    .map((l) => `> ${l}`)
    .join('\n');
}

function quoteBlock(quote: string): string {
  const chars = Array.from(quote);
  const q = chars.length > QUOTE_LIMIT ? `${chars.slice(0, QUOTE_LIMIT).join('')}…` : quote;
  return quoteLines(q);
}

/** Render the top-level threads of a unit as a Markdown conclusion bundle. */
export function buildConclusionBundle(unit: ReviewUnit): string {
  const parts: string[] = [
    '# Review conclusions from Agent Console',
    '',
    'Please apply the conclusions below. If a file has changed since, use the quoted text to relocate the passage.',
  ];
  // A concluded thread is listed unless an ancestor that takes part carries it (children of a failed
  // or unsent thread were folded into the nearest concluded ancestor, or stand on their own).
  const top = unit.threads.filter((t) => t.status === 'resolved' && !carriedByAncestor(unit.threads, t));
  top.forEach((t, i) => {
    const question = t.messages.find((m) => m.role === 'user')?.content ?? '';
    const conclusion = t.noConclusion ? '(clarification only — no change)' : (t.conclusion ?? '');
    parts.push(
      '',
      `## ${i + 1}. ${sourceLabel(unit, t)}`,
      '',
      quoteBlock(t.anchor.quote),
      '',
      '**Question:**',
      quoteLines(question),
      '',
      '**Conclusion:**',
      quoteLines(conclusion),
    );
  });
  return parts.join('\n') + '\n';
}
