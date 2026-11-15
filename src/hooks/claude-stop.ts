import path from 'node:path';
import { callServer } from './client.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  if (process.env.AGENT_CONSOLE_FORK === '1') return;
  try {
    const body = JSON.parse(await readStdin()) as unknown;
    await callServer('POST', '/api/hooks/claude/stop', body);
  } catch {
    // Never disturb the Claude session.
  }
}

// Run only when executed as the hook script, not when imported (tests).
if (/^claude-stop\.(js|ts)$/.test(path.basename(process.argv[1] ?? ''))) {
  main().finally(() => process.exit(0));
}
