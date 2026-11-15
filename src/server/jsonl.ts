import { readFileSync } from 'node:fs';

export type JsonlEntry = Record<string, any>;

/** Reads a JSONL log (Claude transcript, Codex rollout): object lines only; unreadable file -> []. */
export function readJsonl(file: string): JsonlEntry[] {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const entries: JsonlEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj: unknown = JSON.parse(line);
      if (obj && typeof obj === 'object') entries.push(obj as JsonlEntry);
    } catch {
      // skip malformed line
    }
  }
  return entries;
}
