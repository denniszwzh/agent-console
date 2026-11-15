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

/**
 * Forks keep the parent session's tool definitions (so the request prefix, and with it the prompt
 * cache, matches the main session); this hook runs for every tool. Read-only tools get no decision
 * from the hook, so Claude Code's own permission checks still apply to them (in -p default mode a
 * read outside the working directory is refused). Every other tool except the checked shells is denied.
 */
const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const PATH_FIELDS = ['file_path', 'path', 'pattern'];
/** Two leading separators: a UNC share (\\host, //host) or a device path (\\?\, \\.\), which reach the network or devices. */
const UNC_OR_DEVICE = /^[\\/]{2}/;

/**
 * Maps the raw PreToolUse hook stdin to the hook's stdout object, or null for "no decision" (the
 * normal permission flow applies). Fails closed on any error.
 */
export function guardFromStdin(raw: string): GuardOutput | null {
  try {
    const input = JSON.parse(raw) as { tool_name?: unknown; tool_input?: Record<string, unknown> } | null;
    const toolName = input?.tool_name;
    if (typeof toolName !== 'string') return output(false, 'agent-console guard: malformed hook input');
    if (READ_ONLY_TOOLS.has(toolName)) {
      for (const field of PATH_FIELDS) {
        const value = input?.tool_input?.[field];
        if (value === undefined) continue;
        if (typeof value !== 'string') return output(false, 'agent-console guard: malformed hook input');
        if (UNC_OR_DEVICE.test(value.trim())) {
          return output(false, `blocked by agent-console read-only guard: UNC and device paths are not allowed (${field})`);
        }
      }
      return null;
    }
    if (!SHELL_TOOLS.has(toolName)) {
      return output(false, `blocked by agent-console read-only guard: ${toolName} is not available in a review thread`);
    }
    const command = input?.tool_input?.command;
    if (typeof command !== 'string') return output(false, 'agent-console guard: malformed hook input');
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
  let result: GuardOutput | null;
  try {
    result = guardFromStdin(await readStdin());
  } catch {
    result = output(false, 'agent-console guard: could not read the request');
  }
  // Empty stdout with exit 0 = no decision; the normal permission flow continues.
  if (result) process.stdout.write(JSON.stringify(result));
}

// Run only when executed as the hook script, not when imported (tests).
if (/^claude-guard\.(js|ts)$/.test(path.basename(process.argv[1] ?? ''))) {
  void main();
}
