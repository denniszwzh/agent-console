import path from 'node:path';
import { decideGuard } from '../agents/guard.js';

export interface GuardOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny';
    permissionDecisionReason: string;
  };
}

function output(allow: boolean, reason: string): GuardOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: allow ? 'allow' : 'deny',
      permissionDecisionReason: reason,
    },
  };
}

/** Maps the raw PreToolUse hook stdin to the hook's stdout object. Fails closed on any error. */
export function guardFromStdin(raw: string): GuardOutput {
  try {
    const input = JSON.parse(raw) as { tool_name?: unknown; tool_input?: { command?: unknown } } | null;
    const toolName = input?.tool_name;
    const command = input?.tool_input?.command;
    if (typeof toolName !== 'string' || typeof command !== 'string') {
      return output(false, 'agent-console guard: malformed hook input');
    }
    const d = decideGuard(toolName, command);
    return output(d.allow, d.allow ? d.reason : `blocked by agent-console read-only guard: ${d.reason}`);
  } catch {
    return output(false, 'agent-console guard: could not evaluate the request');
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  let result: GuardOutput;
  try {
    result = guardFromStdin(await readStdin());
  } catch {
    result = output(false, 'agent-console guard: could not read the request');
  }
  process.stdout.write(JSON.stringify(result));
}

// Run only when executed as the hook script, not when imported (tests).
if (/^claude-guard\.(js|ts)$/.test(path.basename(process.argv[1] ?? ''))) {
  void main();
}
