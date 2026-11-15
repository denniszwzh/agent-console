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

type Call = (method: 'GET' | 'POST', urlPath: string, body?: unknown) => Promise<unknown | null>;

function writeStdout(s: string): Promise<void> {
  return new Promise((resolve, reject) => process.stdout.write(s, (e) => (e ? reject(e) : resolve())));
}

/**
 * Two-phase delivery: fetch, write to stdout, and only then ack the unit so the server marks it
 * delivered. If we die before the ack, the next prompt injects the same conclusions again.
 */
export async function runPromptHook(stdin: string, call: Call = callServer, write = writeStdout): Promise<void> {
  const input = JSON.parse(stdin) as { session_id?: unknown };
  if (typeof input?.session_id !== 'string' || !input.session_id) return;
  const res = await call('GET', `/api/hooks/claude/prompt?session=${encodeURIComponent(input.session_id)}`);
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
