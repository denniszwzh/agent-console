import { readJsonl, type JsonlEntry } from './jsonl.js';

type Entry = JsonlEntry;

function isTaskStarted(e: Entry): boolean {
  return e.type === 'event_msg' && e.payload?.type === 'task_started';
}

function isUserMessage(e: Entry): boolean {
  return e.type === 'response_item' && e.payload?.type === 'message' && e.payload?.role === 'user';
}

const PATCH_PATH = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)\s*$/;

/** Only the first line is tested: a success output lists file names on later lines. */
function isRejection(output: unknown): boolean {
  if (typeof output !== 'string') return false;
  return /\b(rejected|failed|blocked)\b/i.test(output.split('\n')[0] ?? '');
}

/**
 * Files edited through `apply_patch` during the last turn of a Codex rollout, in first-seen order.
 * The last turn starts at the last `task_started` event (a queued message and the prompt share one
 * turn); without one it starts after the last user message. Calls whose output reports a rejection
 * are skipped. Shell-driven edits are not recorded structurally and are not detected here.
 * Never throws.
 */
export function findChangedFilesCodex(rolloutPath: string): string[] {
  try {
    const entries = readJsonl(rolloutPath);
    let start = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (isTaskStarted(entries[i])) {
        start = i;
        break;
      }
    }
    if (start < 0) {
      for (let i = entries.length - 1; i >= 0; i--) {
        if (isUserMessage(entries[i])) {
          start = i;
          break;
        }
      }
    }
    const turn = entries.slice(start + 1);
    const rejected = new Set<string>();
    for (const e of turn) {
      const p = e.payload;
      if (e.type === 'response_item' && p?.type === 'custom_tool_call_output' && typeof p.call_id === 'string' && isRejection(p.output)) {
        rejected.add(p.call_id);
      }
    }
    const seen = new Set<string>();
    for (const e of turn) {
      const p = e.payload;
      if (e.type !== 'response_item' || p?.type !== 'custom_tool_call' || p.name !== 'apply_patch') continue;
      if (typeof p.call_id === 'string' && rejected.has(p.call_id)) continue;
      if (typeof p.input !== 'string') continue;
      for (const line of p.input.split(/\r?\n/)) {
        const m = PATCH_PATH.exec(line);
        if (m) seen.add(m[1]);
      }
    }
    return [...seen];
  } catch {
    return [];
  }
}
