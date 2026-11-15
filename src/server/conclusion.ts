import type { ReviewUnit, Thread } from '../shared/types.js';

const QUOTE_LIMIT = 300;

function sourceLabel(unit: ReviewUnit, t: Thread): string {
  const file = unit.files.find((f) => f.id === t.anchor.sourceId);
  if (!file || t.anchor.sourceId.startsWith('msg:') || unit.reply.id === t.anchor.sourceId) return 'Reply';
  const hp = t.anchor.headingPath;
  const section = hp.length > 0 ? ` § ${hp.join(' > ')}` : '';
  return `${file.path ?? 'unknown file'}${section} (lines ${t.anchor.startLine}–${t.anchor.endLine})`;
}

function quoteBlock(quote: string): string {
  const q = quote.length > QUOTE_LIMIT ? `${quote.slice(0, QUOTE_LIMIT)}…` : quote;
  return q
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join('\n');
}

/** Render the top-level threads of a unit as a Markdown conclusion bundle. */
export function buildConclusionBundle(unit: ReviewUnit): string {
  const parts: string[] = [
    '# Review conclusions from Agent Console',
    '',
    'Please apply the conclusions below. If a file has changed since, use the quoted text to relocate the passage.',
  ];
  const top = unit.threads.filter((t) => t.parentThreadId === null);
  top.forEach((t, i) => {
    const question = t.messages.find((m) => m.role === 'user')?.content ?? '';
    const conclusion = t.noConclusion ? '(clarification only — no change)' : (t.conclusion ?? '');
    parts.push(
      '',
      `## ${i + 1}. ${sourceLabel(unit, t)}`,
      '',
      quoteBlock(t.anchor.quote),
      '',
      `**Question:** ${question}`,
      '',
      `**Conclusion:** ${conclusion}`,
    );
  });
  return parts.join('\n') + '\n';
}
