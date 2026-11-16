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
 * Paths from completed `FileChange` items (`event_msg` / `item_completed`), in first-seen order.
 * Codex records one per applied patch with absolute paths, also when the patch was applied from
 * code mode (an `exec` tool running JavaScript that calls `tools.apply_patch`), where no top-level
 * `apply_patch` call exists. A successful top-level `apply_patch` gets one too (same call_id; seen
 * in real 0.167 rollouts), so preferring these items loses nothing. A move contributes its destination.
 */
function fileChangePaths(turn: Entry[]): string[] {
  const seen = new Set<string>();
  for (const e of turn) {
    const item = e.type === 'event_msg' && e.payload?.type === 'item_completed' ? e.payload.item : undefined;
    if (!item || item.type !== 'FileChange' || item.status !== 'completed') continue;
    const changes = item.changes;
    if (!changes || typeof changes !== 'object') continue;
    for (const [file, change] of Object.entries(changes as Record<string, { move_path?: unknown } | null>)) {
      const moved = change?.move_path;
      seen.add(typeof moved === 'string' && moved ? moved : file);
    }
  }
  return [...seen];
}

/**
 * Files edited through `apply_patch` during the last turn of a Codex rollout, in first-seen order.
 * Structured `FileChange` items are used when the turn has any; otherwise the patch text of
 * top-level `apply_patch` calls is parsed (older rollouts).
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
    const structured = fileChangePaths(turn);
    if (structured.length > 0) return structured;
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
