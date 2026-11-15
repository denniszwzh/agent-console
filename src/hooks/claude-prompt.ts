import path from 'node:path';
import { callServer } from './client.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Maps the prompt endpoint's answer to the hook's stdout text ('' means no output). */
export function promptOutput(res: unknown): string {
  const r = res as { action?: unknown; text?: unknown; reason?: unknown } | null;
  if (r?.action === 'inject' && typeof r.text === 'string') return r.text;
  if (r?.action === 'block' && typeof r.reason === 'string') {
    return JSON.stringify({ decision: 'block', reason: r.reason });
  }
  return '';
}

async function main(): Promise<void> {
  if (process.env.AGENT_CONSOLE_FORK === '1') return;
  try {
    const input = JSON.parse(await readStdin()) as { session_id?: unknown };
    if (typeof input?.session_id !== 'string' || !input.session_id) return;
    const res = await callServer('GET', `/api/hooks/claude/prompt?session=${encodeURIComponent(input.session_id)}`);
    const out = promptOutput(res);
    if (out) process.stdout.write(out);
  } catch {
    // Never disturb the Claude session.
  }
}

// Run only when executed as the hook script, not when imported (tests).
if (/^claude-prompt\.(js|ts)$/.test(path.basename(process.argv[1] ?? ''))) {
  main().finally(() => process.exit(0));
}
