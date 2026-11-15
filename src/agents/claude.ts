import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dataDir } from '../server/paths.js';
import type { AgentAdapter, AgentEvent, RunRequest } from './adapter.js';
import { killTree } from './kill.js';

const STDERR_TAIL_CHARS = 2000;

export function buildClaudeArgs(req: RunRequest, guardSettingsPath: string): string[] {
  return [
    '-p',
    '--resume', req.parentSessionId,
    ...(req.fork ? ['--fork-session'] : []),
    '--output-format', 'stream-json',
    '--verbose',
    '--tools', 'Read,Grep,Glob,Bash,PowerShell',
    '--disallowedTools', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
    '--strict-mcp-config',
    '--permission-mode', 'default',
    '--settings', guardSettingsPath,
    // Skip user-level settings so the user's own hooks/plugins (e.g. SessionStart hooks that write
    // files into the cwd) never run inside a read-only fork. The --settings guard above still applies.
    '--setting-sources', 'project,local',
  ];
}

type Json = Record<string, unknown>;

function assistantText(msg: Json): string | null {
  const content = (msg.message as Json | undefined)?.content;
  if (!Array.isArray(content)) return null;
  const texts = content
    .filter((c): c is Json => !!c && typeof c === 'object' && (c as Json).type === 'text' && typeof (c as Json).text === 'string')
    .map((c) => c.text as string);
  return texts.length ? texts.join('\n') : null;
}

export async function* parseClaudeStream(lines: AsyncIterable<string>): AsyncIterable<AgentEvent> {
  let sessionSeen = false;
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
    if (!sessionSeen && typeof msg.session_id === 'string') {
      sessionSeen = true;
      yield { type: 'session', sessionId: msg.session_id };
    }
    if (msg.type === 'assistant') {
      const text = assistantText(msg);
      if (text !== null) yield { type: 'text', text };
    } else if (msg.type === 'result') {
      if (msg.is_error === true) {
        const message = typeof msg.result === 'string' && msg.result ? msg.result : String(msg.subtype ?? 'error');
        yield { type: 'error', message };
      } else {
        yield { type: 'done', finalText: typeof msg.result === 'string' ? msg.result : '' };
      }
      return;
    }
  }
}

export interface ClaudeAdapterOptions {
  bin?: string;
  /** Absolute path of the compiled hook script; defaults to dist/hooks/claude-guard.js next to this module. */
  guardScript?: string;
  /** Arguments placed before the Claude arguments (lets tests run a fake CLI through node). */
  binArgs?: string[];
}

function writeGuardSettings(guardScript: string): string {
  // Never run a fork without its read-only hook: a missing script would make the hook fail open.
  if (!fs.existsSync(guardScript)) throw new Error(`guard script not found: ${guardScript} (run npm run build)`);
  const file = path.join(dataDir(), 'guard-settings.json');
  const script = path.resolve(guardScript).replace(/\\/g, '/');
  const settings = {
    hooks: {
      PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: `node "${script}"` }] }],
    },
  };
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  return file;
}

export function createClaudeAdapter(opts: ClaudeAdapterOptions = {}): AgentAdapter {
  const bin = opts.bin ?? 'claude';
  const guardScript = opts.guardScript ?? fileURLToPath(new URL('../hooks/claude-guard.js', import.meta.url));
  const guardSettingsPath = writeGuardSettings(guardScript);

  return {
    kind: 'claude',
    async *run(req, signal) {
      const args = [...(opts.binArgs ?? []), ...buildClaudeArgs(req, guardSettingsPath)];
      const child = spawn(bin, args, {
        cwd: req.cwd,
        env: { ...process.env, AGENT_CONSOLE_FORK: '1', GIT_OPTIONAL_LOCKS: '0' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

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

      let terminal = false;
      try {
        const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
        for await (const ev of parseClaudeStream(rl)) {
          if (ev.type === 'done' || ev.type === 'error') terminal = true;
          yield ev;
        }
        const code = await exited;
        if (!terminal) {
          if (aborted) yield { type: 'error', message: 'aborted' };
          else if (spawnError) yield { type: 'error', message: `failed to start ${bin}: ${(spawnError as Error).message}` };
          else yield { type: 'error', message: `claude exited with code ${code} without a result. ${stderr.trim()}`.trim() };
        }
      } finally {
        signal?.removeEventListener('abort', onAbort);
        if (child.exitCode === null && child.signalCode === null) killTree(child);
      }
    },
  };
}
