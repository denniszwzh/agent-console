import fs from 'node:fs';
import type { AgentKind } from '../shared/types.js';
import { isInterruptRecord, previewOf, type ActivityTracker } from './activity.js';
import type { TranscriptLocator } from './prompt-backfill.js';
import type { UnitStore } from './store.js';
import { isSkippedClaudeRecord, userTextParts } from './turn-prompts.js';

/** How much of a transcript's end is read to find the current turn. */
const TAIL_BYTES = 4 * 1024 * 1024;
/** Only transcripts changed this recently can hold a turn still running (the tracker drops quieter ones too). */
const RECENT_MS = 60 * 60 * 1000;

/** A turn the transcript shows as started and not yet ended. */
export interface OpenTurn {
  since: string;
  prompt?: string;
  /** Codex turn id. */
  turnId?: string;
}

type Rec = Record<string, any>;

/** User records Claude Code writes for things that do not run the model: shell mode and local commands. */
const NOT_A_TURN = /^<(?:bash-input|bash-stdout|bash-stderr|local-command-stdout|local-command-stderr|local-command-caveat|command-name|command-message|command-args)[\s>]/;

function claudeStep(rec: Rec): { start?: string; prompt?: string } | 'end' | undefined {
  if (rec.isSidechain === true) return undefined;
  if (rec.type === 'system' && (rec.subtype === 'stop_hook_summary' || rec.subtype === 'turn_duration')) return 'end';
  if (rec.type === 'assistant' && rec.message?.stop_reason === 'end_turn') return 'end';
  if (rec.type !== 'user') return undefined;
  if (isInterruptRecord(JSON.stringify(rec))) return 'end';
  if (rec.isCompactSummary === true || rec.isVisibleInTranscriptOnly === true) return undefined;
  const parts = userTextParts(rec.message?.content, 'text');
  if (!parts) return undefined; // tool results
  const text = parts.join('\n\n').trim();
  if (!text || NOT_A_TURN.test(text)) return undefined;
  // Meta records (skills loading, reminders) belong to a turn but do not describe it.
  const describes = !isSkippedClaudeRecord(rec) || /<agent-message[\s>]|^<task-notification[\s>]/.test(text);
  return { start: rec.timestamp, prompt: describes ? previewOf(text) : undefined };
}

/**
 * The turn still running at the end of these transcript lines, if any: the first record that starts a
 * turn after the last record that ends one. `cut` says the lines begin mid-file; with no end in them,
 * the turn is taken as running since the first record.
 */
export function openTurnIn(agent: AgentKind, lines: string[], opts: { cut?: boolean } = {}): OpenTurn | undefined {
  let turn: OpenTurn | undefined;
  let ended = false;
  let first: string | undefined;
  for (const l of lines) {
    let rec: Rec;
    try {
      rec = JSON.parse(l) as Rec;
    } catch {
      continue;
    }
    if (!rec || typeof rec !== 'object') continue;
    if (first === undefined && typeof rec.timestamp === 'string') first = rec.timestamp;
    if (agent === 'codex') {
      const p = rec.payload as Rec | undefined;
      if (rec.type === 'event_msg' && p?.type === 'task_started' && typeof rec.timestamp === 'string') {
        turn = { since: rec.timestamp, ...(typeof p.turn_id === 'string' ? { turnId: p.turn_id } : {}) };
      } else if (rec.type === 'event_msg' && (p?.type === 'task_complete' || p?.type === 'turn_aborted')) {
        turn = undefined;
        ended = true;
      } else if (turn && !turn.prompt && rec.type === 'response_item' && p?.type === 'message' && p.role === 'user') {
        const prompt = previewOf((userTextParts(p.content, 'input_text') ?? []).join('\n\n'));
        if (prompt) turn.prompt = prompt;
      }
      continue;
    }
    const step = claudeStep(rec);
    if (step === 'end') {
      turn = undefined;
      ended = true;
    } else if (step?.start && typeof step.start === 'string') {
      if (!turn) turn = { since: step.start };
      if (!turn.prompt && step.prompt) turn.prompt = step.prompt;
    }
  }
  if (turn) return turn;
  return opts.cut && !ended && first ? { since: first } : undefined;
}

/** Reads the end of a transcript and returns its running turn. Never throws. */
export async function readOpenTurn(agent: AgentKind, file: string, tailBytes = TAIL_BYTES): Promise<OpenTurn | undefined> {
  let fh: fs.promises.FileHandle | undefined;
  try {
    fh = await fs.promises.open(file, 'r');
    const { size } = await fh.stat();
    const from = Math.max(0, size - tailBytes);
    const buf = Buffer.alloc(size - from);
    const { bytesRead } = await fh.read(buf, 0, buf.length, from);
    const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n');
    // A read that starts mid-file starts mid-line.
    if (from > 0) lines.shift();
    return openTurnIn(agent, lines, { cut: from > 0 });
  } catch {
    return undefined;
  } finally {
    await fh?.close().catch(() => {});
  }
}

export interface RecoverOptions {
  now?: () => number;
  read?: (agent: AgentKind, file: string) => Promise<OpenTurn | undefined>;
}

/**
 * After a restart the in-memory "responding" state is gone. For every known session whose transcript
 * changed in the last hour, a turn the transcript shows as running (and that started after the
 * session's last reply) is marked responding again. Returns how many were. Sessions that never replied
 * are not known to the store and are not recovered.
 */
export async function recoverActivity(store: UnitStore, tracker: ActivityTracker, locate: TranscriptLocator, opts: RecoverOptions = {}): Promise<number> {
  const now = opts.now ?? Date.now;
  const read = opts.read ?? readOpenTurn;
  let recovered = 0;
  for (const session of store.listSessions()) {
    if (tracker.startedAt(session.sessionId) !== undefined) continue;
    const file = locate(session.agent, session.sessionId, store.transcriptPathFor(session.sessionId));
    if (!file) continue;
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (now() - mtimeMs > RECENT_MS) continue;
    const turn = await read(session.agent, file);
    if (!turn) continue;
    const latest = store.latestForSession(session.sessionId);
    // The Stop for this turn may already have arrived (its end record is written after the hook runs).
    if (latest && Date.parse(turn.since) <= Date.parse(latest.createdAt)) continue;
    // A prompt hook may have started a newer turn while the transcript was read.
    if (tracker.startedAt(session.sessionId) !== undefined) continue;
    tracker.start({
      sessionId: session.sessionId,
      agent: session.agent,
      cwd: latest?.cwd,
      transcriptPath: file,
      prompt: turn.prompt,
      turnId: turn.turnId,
      since: turn.since,
      lastChangeMs: mtimeMs,
    });
    recovered++;
  }
  return recovered;
}
