import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSafeId } from '../shared/ids.js';
import type { AgentKind } from '../shared/types.js';
import { isCodexInstruction } from '../agents/codex.js';
import { acceptableTranscriptPath } from './activity.js';
import { cleanPromptText, isSkippedClaudeRecord, userTextParts } from './turn-prompts.js';

/** Bytes read from the start of a transcript on first sight (creation time, first prompt). */
const HEAD_BYTES = 256 * 1024;
/** Bytes read from the end of a transcript (titles are appended there); also the cap per later read. */
const TAIL_BYTES = 4 * 1024 * 1024;
/**
 * The transcript folders are indexed by one directory walk, shared by every lookup. A session missing
 * from the index (often an old one whose transcript the agent has deleted) triggers a new walk only
 * once the index is this old, so missing sessions cannot keep the server busy.
 */
const MISS_TTL_MS = 5 * 60_000;
/** Codex rollout file name: rollout-YYYY-MM-DDTHH-MM-SS-<thread id>.jsonl */
const ROLLOUT_NAME = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/;
const PROMPT_MAX = 80;
/** The Codex session index is small; anything past this is read from its end only. */
const INDEX_MAX_BYTES = 8 * 1024 * 1024;

export interface SessionMeta {
  title?: string;
  /** 'agent': the agent's own session name; 'prompt': the first prompt, used when there is none. */
  titleSource?: 'agent' | 'prompt';
  createdAt?: string;
  lastModified?: string;
}

export interface SessionMetaOptions {
  claudeHome: string;
  codexHome: string;
  now?: () => number;
}

export function defaultSessionMetaOptions(): SessionMetaOptions {
  return {
    claudeHome: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    codexHome: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  };
}

/** What has been learned from one transcript so far, plus where reading stopped. */
interface FileState {
  size: number;
  mtimeMs: number;
  offset: number;
  /** Bytes of an unfinished last line, completed by the next read. */
  partial: Buffer;
  createdAt?: string;
  customTitle?: string;
  aiTitle?: string;
  /** Claude: first `last-prompt` record. */
  lastPrompt?: string;
  /** First user text that is not injected context. */
  userText?: string;
}

type Rec = Record<string, unknown>;

/**
 * First line of a user prompt, or undefined for empty text, injected context (see cleanPromptText) and
 * Agent Console's own conclusion instruction.
 */
export function promptLine(text: unknown): string | undefined {
  const t = cleanPromptText(text);
  if (!t || isCodexInstruction(t)) return undefined;
  const first = (t.split(/\r?\n/).find((l) => l.trim()) ?? '').trim();
  return first.length > PROMPT_MAX ? `${first.slice(0, PROMPT_MAX)}…` : first;
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function firstPrompt(parts: string[] | undefined): string | undefined {
  for (const p of parts ?? []) {
    const line = promptLine(p);
    if (line) return line;
  }
  return undefined;
}

function applyClaude(s: FileState, rec: Rec): void {
  if (!s.createdAt && typeof rec.timestamp === 'string') s.createdAt = rec.timestamp;
  switch (rec.type) {
    case 'custom-title':
      s.customTitle = nonEmpty(rec.customTitle) ?? s.customTitle;
      break;
    case 'ai-title':
      s.aiTitle = nonEmpty(rec.aiTitle) ?? s.aiTitle;
      break;
    case 'last-prompt':
      s.lastPrompt ??= promptLine(rec.lastPrompt);
      break;
    case 'user':
      if (!s.userText && !isSkippedClaudeRecord(rec)) s.userText = firstPrompt(userTextParts((rec.message as Rec | undefined)?.content, 'text'));
      break;
  }
}

function applyCodex(s: FileState, rec: Rec): void {
  const payload = rec.payload as Rec | undefined;
  if (rec.type === 'session_meta' && typeof payload?.timestamp === 'string') s.createdAt ??= payload.timestamp;
  if (!s.createdAt && typeof rec.timestamp === 'string') s.createdAt = rec.timestamp;
  if (!s.userText && rec.type === 'response_item' && payload?.type === 'message' && payload.role === 'user') {
    s.userText = firstPrompt(userTextParts(payload.content, 'input_text'));
  }
}

function readRange(file: string, start: number, end: number): Buffer {
  const buf = Buffer.alloc(Math.max(0, end - start));
  const fd = fs.openSync(file, 'r');
  try {
    let done = 0;
    while (done < buf.length) {
      const n = fs.readSync(fd, buf, done, buf.length - done, start + done);
      if (n <= 0) break;
      done += n;
    }
    return done === buf.length ? buf : buf.subarray(0, done);
  } finally {
    fs.closeSync(fd);
  }
}

/** Bytes after the first newline: drops a line cut off by starting mid-file. */
function afterFirstNewline(buf: Buffer): Buffer {
  const i = buf.indexOf(0x0a);
  return i < 0 ? Buffer.alloc(0) : buf.subarray(i + 1);
}

/** Feeds complete lines to `apply`; returns the unfinished tail (no trailing newline). */
function feedLines(buf: Buffer, apply: (rec: Rec) => void): Buffer {
  let start = 0;
  for (;;) {
    const nl = buf.indexOf(0x0a, start);
    if (nl < 0) return buf.subarray(start);
    const text = buf.toString('utf8', start, nl).trim();
    start = nl + 1;
    if (!text.startsWith('{')) continue;
    try {
      const rec = JSON.parse(text) as unknown;
      if (rec && typeof rec === 'object') apply(rec as Rec);
    } catch {
      // Not a JSON record (or a corrupt one): skip it.
    }
  }
}

export class SessionMetaService {
  private readonly now: () => number;
  private readonly files = new Map<string, FileState>();
  /** Session id -> transcript path, per agent, from the last walk of its transcript folders. */
  private readonly indexes = new Map<AgentKind, { builtAt: number; paths: Map<string, string> }>();
  private codexIndex: { size: number; mtimeMs: number; names: Map<string, string> } | null = null;
  private readonly warned = new Set<string>();

  constructor(private readonly opts: SessionMetaOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Name and times of one session, from its transcript; empty when it cannot be found. Never throws. */
  describe(agent: AgentKind, sessionId: string, knownPath?: string): SessionMeta {
    if (!isSafeId(sessionId)) return {};
    let file: string | undefined;
    try {
      file = this.locate(agent, sessionId, knownPath);
      if (!file) return {};
      const st = fs.statSync(file);
      const meta: SessionMeta = { lastModified: st.mtime.toISOString() };
      const s = this.read(file, st, agent === 'claude' ? applyClaude : applyCodex);
      const title = agent === 'claude' ? (s.customTitle ?? s.aiTitle) : this.codexName(sessionId);
      const prompt = s.lastPrompt ?? s.userText;
      if (title) Object.assign(meta, { title, titleSource: 'agent' });
      else if (prompt) Object.assign(meta, { title: prompt, titleSource: 'prompt' });
      if (s.createdAt) meta.createdAt = s.createdAt;
      return meta;
    } catch (e) {
      const key = file ?? `${agent}:${sessionId}`;
      if (!this.warned.has(key)) {
        this.warned.add(key);
        console.warn(`[session-meta] cannot read ${key}: ${(e as Error).message}`);
      }
      return {};
    }
  }

  private locate(agent: AgentKind, sessionId: string, knownPath?: string): string | undefined {
    const known = acceptableTranscriptPath(knownPath);
    if (known && isFile(known)) return known;
    let index = this.indexes.get(agent);
    const hit = index?.paths.get(sessionId);
    if (hit && isFile(hit)) return hit;
    if (index && this.now() - index.builtAt < MISS_TTL_MS) return undefined;
    index = { builtAt: this.now(), paths: agent === 'claude' ? this.indexClaude() : this.indexCodex() };
    this.indexes.set(agent, index);
    return index.paths.get(sessionId);
  }

  /** Every <claudeHome>/projects/<project>/<session>.jsonl, in one pass. */
  private indexClaude(): Map<string, string> {
    const paths = new Map<string, string>();
    const projects = path.join(this.opts.claudeHome, 'projects');
    for (const d of readDirs(projects)) {
      const dir = path.join(projects, d);
      for (const name of readFiles(dir)) {
        if (name.endsWith('.jsonl')) paths.set(name.slice(0, -'.jsonl'.length), path.join(dir, name));
      }
    }
    return paths;
  }

  /** Every Codex rollout in sessions/YYYY/MM/DD; for a thread found twice, the newest day wins. */
  private indexCodex(): Map<string, string> {
    const paths = new Map<string, string>();
    const root = path.join(this.opts.codexHome, 'sessions');
    for (const y of readDirs(root).sort()) {
      for (const m of readDirs(path.join(root, y)).sort()) {
        for (const d of readDirs(path.join(root, y, m)).sort()) {
          const dir = path.join(root, y, m, d);
          for (const name of readFiles(dir).sort()) {
            const id = ROLLOUT_NAME.exec(name)?.[1];
            if (id) paths.set(id, path.join(dir, name));
          }
        }
      }
    }
    return paths;
  }

  private read(file: string, st: fs.Stats, apply: (s: FileState, rec: Rec) => void): FileState {
    let s = this.files.get(file);
    if (s && st.size < s.size) s = undefined; // Rewritten or truncated: start over.
    if (s && st.size === s.size) {
      s.mtimeMs = st.mtimeMs;
      return s;
    }
    if (!s) {
      const fresh: FileState = { size: st.size, mtimeMs: st.mtimeMs, offset: st.size, partial: Buffer.alloc(0) };
      const feed = (buf: Buffer) => feedLines(buf, (rec) => apply(fresh, rec));
      if (st.size <= HEAD_BYTES + TAIL_BYTES) {
        fresh.partial = Buffer.from(feed(readRange(file, 0, st.size)));
      } else {
        feed(readRange(file, 0, HEAD_BYTES));
        fresh.partial = Buffer.from(feed(afterFirstNewline(readRange(file, st.size - TAIL_BYTES, st.size))));
      }
      this.files.set(file, fresh);
      return fresh;
    }
    // Grown: read only what was appended (at most the last TAIL_BYTES of it).
    const state = s;
    const feed = (buf: Buffer) => feedLines(buf, (rec) => apply(state, rec));
    if (st.size - state.offset > TAIL_BYTES) {
      state.partial = Buffer.from(feed(afterFirstNewline(readRange(file, st.size - TAIL_BYTES, st.size))));
    } else {
      state.partial = Buffer.from(feed(Buffer.concat([state.partial, readRange(file, state.offset, st.size)])));
    }
    state.offset = st.size;
    state.size = st.size;
    state.mtimeMs = st.mtimeMs;
    return state;
  }

  /** Latest `thread_name` of a Codex session in ~/.codex/session_index.jsonl (later lines win). */
  private codexName(sessionId: string): string | undefined {
    const file = path.join(this.opts.codexHome, 'session_index.jsonl');
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      return undefined;
    }
    if (!this.codexIndex || this.codexIndex.size !== st.size || this.codexIndex.mtimeMs !== st.mtimeMs) {
      const names = new Map<string, string>();
      const start = Math.max(0, st.size - INDEX_MAX_BYTES);
      let buf = readRange(file, start, st.size);
      if (start > 0) buf = afterFirstNewline(buf);
      // The index may end without a newline: add one so its last line is read too.
      feedLines(Buffer.concat([buf, Buffer.from('\n')]), (rec) => {
        const name = nonEmpty(rec.thread_name);
        if (typeof rec.id === 'string' && name) names.set(rec.id, name);
      });
      this.codexIndex = { size: st.size, mtimeMs: st.mtimeMs, names };
    }
    return this.codexIndex.names.get(sessionId);
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function readFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function readDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}
