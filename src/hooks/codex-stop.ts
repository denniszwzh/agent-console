import path from 'node:path';
import { callServer, readStdin } from './client.js';

/** Forwards a Codex Stop payload to the panel. Never throws. */
export async function forwardCodexStop(raw: string, post: typeof callServer = callServer): Promise<void> {
  try {
    await post('POST', '/api/hooks/codex/stop', JSON.parse(raw) as unknown);
  } catch {
    // Never disturb the Codex session.
  }
}

async function main(): Promise<void> {
  if (process.env.AGENT_CONSOLE_FORK === '1') return;
  await forwardCodexStop(await readStdin());
}

// Codex requires JSON on stdout for Stop hooks; `{}` observes without blocking. Printed exactly once.
let answered = false;
function finish(): void {
  if (answered) return;
  answered = true;
  process.stdout.write('{}\n', () => process.exit(0));
  setTimeout(() => process.exit(0), 200).unref();
}

// Run only when executed as the hook script, not when imported (tests).
if (/^codex-stop\.(js|ts)$/.test(path.basename(process.argv[1] ?? ''))) {
  // Hard budget: never hold up the Codex session.
  setTimeout(finish, 3000).unref();
  main().finally(finish);
}
