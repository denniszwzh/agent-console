import path from 'node:path';
import { callServer, readStdin } from './client.js';

/** Maps the prompt endpoint's answer to the hook's stdout text ('' means no output). */
export function promptOutput(res: unknown): string {
  const r = res as { action?: unknown; text?: unknown; reason?: unknown } | null;
  if (r?.action === 'inject' && typeof r.text === 'string') return r.text;
  if (r?.action === 'block' && typeof r.reason === 'string') {
    return JSON.stringify({ decision: 'block', reason: r.reason });
  }
  return '';
}

/** Characters of the prompt sent to the panel (it only shows the first line, shortened). */
const PROMPT_CHARS = 200;

/**
 * Query string for the prompt endpoint. Besides the session it carries what the panel needs to
 * show "responding" (cwd, transcript path for interrupt detection, and the start of the prompt).
 * It stays a GET with extra parameters so an older running server still answers it.
 */
export function promptQuery(sessionId: string, input: { cwd?: unknown; transcript_path?: unknown; prompt?: unknown }): string {
  const q = new URLSearchParams({ session: sessionId });
  if (typeof input.cwd === 'string' && input.cwd) q.set('cwd', input.cwd);
  if (typeof input.transcript_path === 'string' && input.transcript_path) q.set('transcript', input.transcript_path);
  if (typeof input.prompt === 'string' && input.prompt) q.set('prompt', input.prompt.slice(0, PROMPT_CHARS));
  return q.toString();
}

type Call =(method: 'GET' | 'POST', urlPath: string, body?: unknown) => Promise<unknown | null>;

function writeStdout(s: string): Promise<void> {
  return new Promise((resolve, reject) => process.stdout.write(s, (e) => (e ? reject(e) : resolve())));
}

/**
 * Two-phase delivery: fetch, write to stdout, and only then ack the unit so the server marks it
 * delivered. If we die before the ack, the next prompt injects the same conclusions again.
 */
export async function runPromptHook(stdin: string, call: Call = callServer, write = writeStdout): Promise<void> {
  const input = JSON.parse(stdin) as { session_id?: unknown; cwd?: unknown; transcript_path?: unknown; prompt?: unknown };
  if (typeof input?.session_id !== 'string' || !input.session_id) return;
  const res = await call('GET', `/api/hooks/claude/prompt?${promptQuery(input.session_id, input)}`);
  const out = promptOutput(res);
  if (!out) return;
  await write(out);
  const unitId = (res as { action?: unknown; unitId?: unknown }).unitId;
  if ((res as { action?: unknown }).action === 'inject' && typeof unitId === 'string') {
    await call('POST', '/api/hooks/claude/prompt/ack', { unitId });
  }
}

async function main(): Promise<void> {
  if (process.env.AGENT_CONSOLE_FORK === '1') return;
  try {
    await runPromptHook(await readStdin());
  } catch {
    // Never disturb the Claude session.
  }
}

// Run only when executed as the hook script, not when imported (tests).
if (/^claude-prompt\.(js|ts)$/.test(path.basename(process.argv[1] ?? ''))) {
  // Hard budget: never hold up the Claude session.
  setTimeout(() => process.exit(0), 3000).unref();
  main().finally(() => process.exit(0));
}
