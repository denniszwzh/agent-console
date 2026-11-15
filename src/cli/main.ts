#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { addHooks, removeHooks } from './settings-merge.js';
import { start } from '../server/main.js';
import { ensureToken, readConfig } from '../server/paths.js';

const USAGE = `Usage: agent-console [install | uninstall]

  (no command)  start the server and open the browser
  install       add the Stop / UserPromptSubmit hooks to ~/.claude/settings.json
  uninstall     remove the hooks added by install`;

function readSettings(file: string): object {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as object;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
}

function hooksOf(s: object): unknown {
  return (s as { hooks?: unknown }).hooks ?? {};
}

/** Reads one line from stdin; only y / yes (any case) confirms. */
async function askYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.once('close', () => resolve(''));
    rl.question(question, resolve);
  });
  rl.close();
  return ['y', 'yes'].includes(answer.trim().toLowerCase());
}

/** Shared install/uninstall flow. The settings path is a parameter; only main() picks the default. */
export async function applyChange(
  settingsPath: string,
  transform: (s: object) => object,
  confirm: (q: string) => Promise<boolean> = askYesNo,
  log: (s: string) => void = console.log,
): Promise<boolean> {
  const before = readSettings(settingsPath);
  const after = transform(before);
  const b = JSON.stringify(hooksOf(before), null, 2);
  const a = JSON.stringify(hooksOf(after), null, 2);
  if (a === b) {
    log('Nothing to change.');
    return false;
  }
  log(`File: ${settingsPath}\n--- hooks (before)\n${b}\n+++ hooks (after)\n${a}`);
  if (!(await confirm('Apply? (y/N) '))) {
    log('Aborted. No changes written.');
    return false;
  }
  if (fs.existsSync(settingsPath)) {
    fs.copyFileSync(settingsPath, `${settingsPath}.agent-console-backup-${Date.now()}`);
  } else {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  }
  fs.writeFileSync(settingsPath, JSON.stringify(after, null, 2) + '\n');
  log('Done.');
  return true;
}

export function hookCommands(): { Stop: string; UserPromptSubmit: string } {
  const p = (name: string) => fileURLToPath(new URL(`../hooks/${name}`, import.meta.url));
  return {
    Stop: `node "${p('claude-stop.js')}"`,
    UserPromptSubmit: `node "${p('claude-prompt.js')}"`,
  };
}

async function main(): Promise<void> {
  const sub = process.argv[2];
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  if (sub === 'install') {
    await applyChange(settingsPath, (s) => addHooks(s, hookCommands()));
  } else if (sub === 'uninstall') {
    await applyChange(settingsPath, removeHooks);
  } else if (sub === undefined) {
    await start();
    const url = `http://127.0.0.1:${readConfig().port}/auth?token=${ensureToken()}`;
    execFile('cmd', ['/c', 'start', '""', url], () => {});
  } else {
    console.error(USAGE);
    process.exit(1);
  }
}

// Run only when executed directly (npm bin shims are symlinks/wrappers, so compare real paths).
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
