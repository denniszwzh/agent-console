import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { isSafeId } from '../shared/ids.js';
import type { AgentAdapter, AgentEvent, RunRequest } from './adapter.js';
import { killTree } from './kill.js';

const STDERR_TAIL_CHARS = 2000;
const QUEUE_TIMEOUT_MS = 10_000;

/**
 * `-s read-only` must sit on `exec`, before fork/resume: the sub-subcommands reject the flag.
 * The prompt is read from stdin (`-`), never put in argv. `resume` reuses the parent's thread id.
 */
export function buildCodexArgs(req: RunRequest): string[] {
  if (!isSafeId(req.parentSessionId)) throw new Error('invalid session id');
  return ['exec', '-s', 'read-only', '--json', req.fork ? 'fork' : 'resume', req.parentSessionId, '-'];
}

type Json = Record<string, unknown>;

function errorMessage(msg: Json): string {
  const err = msg.error;
  if (err && typeof err === 'object' && typeof (err as Json).message === 'string') return (err as Json).message as string;
  if (typeof err === 'string' && err) return err;
  if (typeof msg.message === 'string' && msg.message) return msg.message;
  return String(msg.type);
}

export async function* parseCodexStream(lines: AsyncIterable<string>): AsyncIterable<AgentEvent> {
  let sessionSeen = false;
  let lastText = '';
  let lastError: string | null = null;
  for await (const line of lines) {
    if (!line.trim()) continue;
    let msg: Json;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      msg = parsed as Json;
    } catch {
      continue;
    }
    if (msg.type === 'thread.started') {
      if (!sessionSeen && typeof msg.thread_id === 'string') {
        sessionSeen = true;
        yield { type: 'session', sessionId: msg.thread_id };
      }
    } else if (msg.type === 'item.completed') {
      const item = msg.item as Json | undefined;
      if (item && item.type === 'agent_message' && typeof item.text === 'string') {
        lastText = item.text;
        yield { type: 'text', text: item.text };
      }
    } else if (msg.type === 'turn.completed') {
      yield { type: 'done', finalText: lastText };
      return;
    } else if (msg.type === 'turn.failed') {
      yield { type: 'error', message: errorMessage(msg) };
      return;
    } else if (msg.type === 'error') {
      // Codex emits transient notices (e.g. "Reconnecting... 1/5"); only the stream end decides.
      lastError = errorMessage(msg);
    }
  }
  if (lastError !== null) yield { type: 'error', message: lastError };
}

export interface CodexAdapterOptions {
  bin?: string;
  /** Arguments placed before the Codex arguments (lets tests run a fake CLI through node). */
  binArgs?: string[];
}

export function createCodexAdapter(opts: CodexAdapterOptions = {}): AgentAdapter {
  const bin = opts.bin ?? 'codex';
  return {
    kind: 'codex',
    async *run(req, signal) {
      let args: string[];
      try {
        args = [...(opts.binArgs ?? []), ...buildCodexArgs(req)];
      } catch (e) {
        yield { type: 'error', message: (e as Error).message };
        return;
      }
      const child = spawn(bin, args, {
        cwd: req.cwd,
        env: { ...process.env, AGENT_CONSOLE_FORK: '1', GIT_OPTIONAL_LOCKS: '0' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      // stderr is log noise (e.g. websocket fallbacks); it is only kept for error messages.
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d: string) => {
        stderr = (stderr + d).slice(-STDERR_TAIL_CHARS);
      });
      let spawnError: Error | null = null;
      child.on('error', (e) => {
        spawnError = e;
      });
      const exited = new Promise<number | null>((resolve) => {
        child.on('close', (code) => resolve(code));
        child.on('error', () => resolve(null));
      });
      child.stdin.on('error', () => {}); // EPIPE when the child dies early; surfaced via exit handling
      child.stdin.end(req.prompt, 'utf8');

      let aborted = signal?.aborted ?? false;
      const onAbort = () => {
        aborted = true;
        killTree(child);
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      let errored = false;
      let doneText: string | null = null;
      try {
        const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
        for await (const ev of parseCodexStream(rl)) {
          if (ev.type === 'done') {
            // Hold the verdict until the exit code is known: a non-zero exit is an error.
            doneText = ev.finalText;
            continue;
          }
          if (ev.type === 'error') errored = true;
          yield ev;
        }
        const code = await exited;
        if (errored) return;
        if (aborted) yield { type: 'error', message: 'aborted' };
        else if (doneText !== null && code === 0) yield { type: 'done', finalText: doneText };
        else if (spawnError) yield { type: 'error', message: `failed to start ${bin}: ${(spawnError as Error).message}` };
        else {
          const why = doneText !== null ? `exited with code ${code}` : `exited with code ${code} without finishing a turn`;
          yield { type: 'error', message: `codex ${why}. ${stderr.trim()}`.trim() };
        }
      } finally {
        signal?.removeEventListener('abort', onAbort);
        if (child.exitCode === null && child.signalCode === null) killTree(child);
      }
    },
  };
}

/** Text handed to the main Codex session (copy button and queue). */
export function codexInstruction(conclusionsPath: string): string {
  return `Read the review conclusions in ${conclusionsPath} and apply them.`;
}

/** Sends one message to a Codex thread's queue. Resolves true on success; never rejects. */
export type CodexQueueRunner = (threadId: string, message: string) => Promise<boolean>;

export function createCodexQueueRunner(opts: { bin?: string; binArgs?: string[]; timeoutMs?: number } = {}): CodexQueueRunner {
  const bin = opts.bin ?? 'codex';
  return (threadId, message) =>
    new Promise<boolean>((resolve) => {
      if (!isSafeId(threadId)) {
        console.error('codex queue failed: invalid thread id');
        resolve(false);
        return;
      }
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (ok: boolean, why?: string) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (!ok) console.error(`codex queue failed: ${why ?? 'unknown'}`);
        resolve(ok);
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(bin, [...(opts.binArgs ?? []), 'queue', '--thread', threadId, '--message', message], {
          stdio: ['ignore', 'ignore', 'pipe'],
          env: { ...process.env, AGENT_CONSOLE_FORK: '1' },
          windowsHide: true,
        });
      } catch (e) {
        finish(false, (e as Error).message);
        return;
      }
      timer = setTimeout(() => {
        killTree(child);
        finish(false, 'timed out');
      }, opts.timeoutMs ?? QUEUE_TIMEOUT_MS);
      let stderr = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (d: string) => {
        stderr = (stderr + d).slice(-STDERR_TAIL_CHARS);
      });
      child.on('error', (e) => finish(false, e.message));
      child.on('close', (code) => finish(code === 0, `exit code ${code}. ${stderr.trim()}`));
    });
}
