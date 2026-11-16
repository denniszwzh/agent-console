import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { AgentKind, SessionActivity } from '../shared/types.js';
import type { EventBus } from './events.js';

/** How often active sessions' transcripts are checked for an interrupt. */
const POLL_MS = 2000;
/** A turn whose transcript has not grown for this long is assumed gone (crash, closed terminal). */
const STALE_MS = 60 * 60 * 1000;
/** Upper bound on bytes read per poll; after a larger jump only the last MAX_READ bytes are read. */
const MAX_READ = 8 * 1024 * 1024;
/** Transcript growth is pushed to the panel at most this often per session (it drives the "quiet" hint). */
const PROGRESS_EMIT_MS = 30 * 1000;
/** A line longer than this without a newline is not an interrupt record; stop buffering it. */
const MAX_PARTIAL = 64 * 1024;
const PROMPT_PREVIEW = 120;
const INTERRUPT_MARK = '[Request interrupted by user';

interface Entry {
  activity: SessionActivity;
  transcriptPath?: string;
  offset: number;
  partial: string;
  decoder: StringDecoder;
  lastChangeMs: number;
  lastEmitMs: number;
  turnId?: string;
}

export interface StartInput {
  sessionId: string;
  agent: AgentKind;
  cwd?: string;
  transcriptPath?: string;
  prompt?: string;
  /** Codex turn id; lets a late Interrupt for an earlier turn leave the current one alone. */
  turnId?: string;
}

/** True when a transcript line is the user-side record Claude Code writes when a turn is interrupted. */
export function isInterruptRecord(line: string): boolean {
  if (!line.includes(INTERRUPT_MARK)) return false;
  try {
    const rec = JSON.parse(line) as { type?: unknown; message?: { content?: unknown } };
    if (rec.type !== 'user') return false;
    const content = rec.message?.content;
    if (typeof content === 'string') return content.startsWith(INTERRUPT_MARK);
    return (
      Array.isArray(content) &&
      content.some((c) => (c as { type?: unknown; text?: unknown })?.type === 'text' && String((c as { text?: unknown }).text).startsWith(INTERRUPT_MARK))
    );
  } catch {
    return false;
  }
}

function previewOf(prompt: string | undefined): string | undefined {
  if (!prompt) return undefined;
  const line = prompt.split(/\r?\n/).find((l) => l.trim()) ?? '';
  const t = line.trim();
  if (!t) return undefined;
  return t.length > PROMPT_PREVIEW ? `${t.slice(0, PROMPT_PREVIEW)}…` : t;
}

/**
 * Accepts only an absolute local *.jsonl path. UNC and device paths are refused: polling them would
 * reach the network (SMB) or a device from a synchronous stat every two seconds.
 */
export function acceptableTranscriptPath(p: string | undefined): string | undefined {
  if (!p) return undefined;
  if (/^[\\/]{2}/.test(p) || !path.isAbsolute(p) || !p.toLowerCase().endsWith('.jsonl')) return undefined;
  return p;
}

function fileSize(p: string): number | null {
  try {
    return fs.statSync(p).size;
  } catch {
    return null;
  }
}

/**
 * In-memory "the main session is working on a turn" state. A prompt hook starts it, the Stop hook
 * ends it. Claude Code does not run Stop when the user interrupts a turn, so the transcript's newly
 * appended lines are watched for the interrupt record; a turn that goes quiet for an hour is dropped.
 */
export class ActivityTracker {
  private entries = new Map<string, Entry>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly bus: EventBus,
    private readonly now: () => number = Date.now,
  ) {}

  list(): SessionActivity[] {
    return [...this.entries.values()].map((e) => ({ ...e.activity, lastChange: new Date(e.lastChangeMs).toISOString() }));
  }

  start(input: StartInput): void {
    const nowMs = this.now();
    const transcriptPath = acceptableTranscriptPath(input.transcriptPath);
    this.entries.set(input.sessionId, {
      activity: {
        sessionId: input.sessionId,
        agent: input.agent,
        cwd: input.cwd ?? '',
        since: new Date(nowMs).toISOString(),
        lastChange: new Date(nowMs).toISOString(),
        prompt: previewOf(input.prompt),
      },
      transcriptPath,
      // Only lines appended after the prompt matter; an older interrupt must not end the new turn.
      offset: (transcriptPath && fileSize(transcriptPath)) || 0,
      partial: '',
      decoder: new StringDecoder('utf8'),
      lastChangeMs: nowMs,
      lastEmitMs: nowMs,
      turnId: input.turnId || undefined,
    });
    this.emit(input.sessionId);
    this.ensureTimer();
  }

  /**
   * Ends a session's turn; returns whether one was active. With `turnId`, only that turn is ended
   * (an Interrupt that arrives after the next prompt must not clear the new turn).
   */
  end(sessionId: string, turnId?: string): boolean {
    const e = this.entries.get(sessionId);
    if (!e) return false;
    if (turnId && e.turnId && turnId !== e.turnId) return false;
    this.entries.delete(sessionId);
    this.emit(sessionId);
    if (this.entries.size === 0) this.stopTimer();
    return true;
  }

  /** One polling pass (exposed for tests). */
  poll(): void {
    const nowMs = this.now();
    for (const [sessionId, e] of [...this.entries]) {
      if (e.transcriptPath && this.readAppended(e, nowMs)) {
        this.end(sessionId);
        continue;
      }
      if (nowMs - e.lastChangeMs > STALE_MS) this.end(sessionId);
    }
  }

  close(): void {
    this.stopTimer();
    this.entries.clear();
  }

  /** Reads what was appended since the last pass; returns true if it contains an interrupt record. */
  private readAppended(e: Entry, nowMs: number): boolean {
    const size = fileSize(e.transcriptPath!);
    if (size === null || size === e.offset) return false;
    e.lastChangeMs = nowMs;
    if (nowMs - e.lastEmitMs >= PROGRESS_EMIT_MS) {
      e.lastEmitMs = nowMs;
      this.emit(e.activity.sessionId);
    }
    let from = e.offset;
    let skipFirstLine = false;
    if (size < e.offset || size - e.offset > MAX_READ) {
      // Truncated, or a huge jump: read only the tail (an interrupt record is written last), starting
      // after its first newline because that read begins mid-line.
      from = Math.max(0, size - MAX_READ);
      skipFirstLine = from > 0;
      e.partial = '';
      e.decoder = new StringDecoder('utf8');
    }
    let text = '';
    try {
      const fd = fs.openSync(e.transcriptPath!, 'r');
      try {
        const buf = Buffer.alloc(size - from);
        const n = fs.readSync(fd, buf, 0, buf.length, from);
        // The decoder keeps a multi-byte character split at the read boundary for the next pass.
        text = e.decoder.write(buf.subarray(0, n));
        e.offset = from + n;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return false;
    }
    const lines = (e.partial + text).split('\n');
    if (skipFirstLine) lines.shift();
    e.partial = lines.pop() ?? '';
    if (e.partial.length > MAX_PARTIAL) e.partial = '';
    return lines.some(isInterruptRecord);
  }

  private emit(sessionId: string): void {
    this.bus.emit({ type: 'activity.updated', sessionId });
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), POLL_MS);
    this.timer.unref();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
