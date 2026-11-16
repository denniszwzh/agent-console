import path from 'node:path';
import { callServer, readStdin } from './client.js';

/** Characters of the prompt sent to the panel (it only shows the first line, shortened). */
const PROMPT_CHARS = 200;

/**
 * Tells the panel that a Codex turn started (UserPromptSubmit) or was interrupted (Interrupt).
 * Prints nothing: for UserPromptSubmit plain stdout would be added to the model's context, and for
 * Interrupt plain text is invalid. Never throws.
 */
export async function forwardCodexActivity(raw: string, post: typeof callServer = callServer): Promise<void> {
  try {
    const input = JSON.parse(raw) as {
      hook_event_name?: unknown;
      session_id?: unknown;
      cwd?: unknown;
      transcript_path?: unknown;
      prompt?: unknown;
      turn_id?: unknown;
    } | null;
    const sessionId = input?.session_id;
    if (typeof sessionId !== 'string' || !sessionId) return;
    if (input?.hook_event_name === 'UserPromptSubmit') {
      await post('POST', '/api/hooks/codex/prompt', {
        session_id: sessionId,
        cwd: typeof input.cwd === 'string' ? input.cwd : undefined,
        transcript_path: typeof input.transcript_path === 'string' ? input.transcript_path : undefined,
        prompt: typeof input.prompt === 'string' ? input.prompt.slice(0, PROMPT_CHARS) : undefined,
        turn_id: typeof input.turn_id === 'string' ? input.turn_id : undefined,
      });
    } else if (input?.hook_event_name === 'Interrupt') {
      await post('POST', '/api/hooks/codex/interrupt', {
        session_id: sessionId,
        turn_id: typeof input.turn_id === 'string' ? input.turn_id : undefined,
      });
    }
  } catch {
    // Never disturb the Codex session.
  }
}

async function main(): Promise<void> {
  if (process.env.AGENT_CONSOLE_FORK === '1') return;
  await forwardCodexActivity(await readStdin());
}

// Run only when executed as the hook script, not when imported (tests).
if (/^codex-activity\.(js|ts)$/.test(path.basename(process.argv[1] ?? ''))) {
  // Hard budget well below Codex's 3 s cap for Interrupt hooks (node startup comes on top);
  // exit 0 with no output either way.
  setTimeout(() => process.exit(0), 2000).unref();
  main().finally(() => process.exit(0));
}
