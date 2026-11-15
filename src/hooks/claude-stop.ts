import path from 'node:path';
import { callServer, readStdin } from './client.js';

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
  // Hard budget: never hold up the Claude session.
  setTimeout(() => process.exit(0), 3000).unref();
  main().finally(() => process.exit(0));
}
