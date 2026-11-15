import { readFileSync } from 'node:fs';

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

type Entry = Record<string, any>;

function parseLines(path: string): Entry[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const entries: Entry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object') entries.push(obj);
    } catch {
      // skip malformed line
    }
  }
  return entries;
}

function isRealUserPrompt(e: Entry): boolean {
  if (e.type !== 'user' || e.isMeta || e.isSidechain) return false;
  const content = e.message?.content;
  if (typeof content === 'string') return true;
  return Array.isArray(content) && content.some((c: Entry) => c?.type === 'text');
}

export function findChangedFilesClaude(transcriptPath: string, sessionId: string): string[] {
  const entries = parseLines(transcriptPath);
  let start = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isRealUserPrompt(entries[i])) {
      start = i;
      break;
    }
  }
  const seen = new Set<string>();
  for (const e of entries.slice(start + 1)) {
    if (e.type !== 'assistant' || e.isSidechain === true || e.sessionId !== sessionId) continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (item?.type !== 'tool_use' || !EDIT_TOOLS.has(item.name)) continue;
      const p = item.name === 'NotebookEdit' ? item.input?.notebook_path : item.input?.file_path;
      if (typeof p === 'string' && p) seen.add(p);
    }
  }
  return [...seen];
}
