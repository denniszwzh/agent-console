#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { addCodexHooks, addHooks, assertRecognisable, HooksShapeError, removeHooks } from './settings-merge.js';
import { callServer } from '../hooks/client.js';
import { start } from '../server/main.js';
import { dataDir, ensureToken, readConfig, readServerInfo } from '../server/paths.js';

const USAGE = `Usage: agent-console [install | uninstall]

  (no command)  start the server and open the browser
  install       add the Stop / UserPromptSubmit hooks to ~/.claude/settings.json
                and the Stop hook to ~/.codex/hooks.json (if ~/.codex exists)
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
  let after: object;
  try {
    after = transform(before); // throws on an unsafe settings shape
  } catch (e) {
    if (e instanceof HooksShapeError) throw new Error(`"hooks" in ${path.basename(settingsPath)} is not an object; refusing to modify it`);
    throw e;
  }
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
  const tmp = `${settingsPath}.agent-console-tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(after, null, 2) + '\n');
  fs.renameSync(tmp, settingsPath);
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

export function codexHookCommands(): { Stop: string } {
  return { Stop: `node "${fileURLToPath(new URL('../hooks/codex-stop.js', import.meta.url))}"` };
}

export const CODEX_TRUST_NOTICE =
  'Codex skips hooks it has not been told to trust. Open the Codex TUI and run /hooks once to review and trust the Agent Console Stop hook; until then it will not fire.';

export interface InstallTargets {
  claudeSettings: string;
  /** The Codex home directory (hooks.json lives inside it). */
  codexDir: string;
}

export function defaultTargets(): InstallTargets {
  return {
    claudeSettings: path.join(os.homedir(), '.claude', 'settings.json'),
    codexDir: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  };
}

/** Claude first, then Codex; each change is confirmed separately. Codex is skipped when its directory is missing. */
export async function runInstall(
  t: InstallTargets,
  confirm: (q: string) => Promise<boolean> = askYesNo,
  log: (s: string) => void = console.log,
): Promise<void> {
  const cmds = hookCommands();
  const codexCmds = codexHookCommands();
  assertRecognisable(cmds);
  assertRecognisable(codexCmds);
  await applyChange(t.claudeSettings, (s) => addHooks(s, cmds), confirm, log);
  if (!fs.existsSync(t.codexDir)) {
    log(`Skipping Codex: ${t.codexDir} does not exist.`);
    return;
  }
  const hooksFile = path.join(t.codexDir, 'hooks.json');
  await applyChange(hooksFile, (s) => addCodexHooks(s, codexCmds), confirm, log);
  // Remind whenever our hook is present, also when it was already installed.
  if (JSON.stringify(readSettings(hooksFile)).includes('codex-stop.js')) log(CODEX_TRUST_NOTICE);
}

export async function runUninstall(
  t: InstallTargets,
  confirm: (q: string) => Promise<boolean> = askYesNo,
  log: (s: string) => void = console.log,
): Promise<void> {
  await applyChange(t.claudeSettings, removeHooks, confirm, log);
  if (!fs.existsSync(t.codexDir)) {
    log(`Skipping Codex: ${t.codexDir} does not exist.`);
    return;
  }
  await applyChange(path.join(t.codexDir, 'hooks.json'), removeHooks, confirm, log);
}

function openBrowser(url: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    execFile(cmd, args, () => {});
  } catch {
    // Opening the browser is best effort.
  }
}

/** True when server.json points at a live Agent Console that accepts our token. */
async function probeRunningConsole(): Promise<boolean> {
  return Array.isArray(await callServer('GET', '/api/sessions'));
}

export interface LaunchDeps {
  start: () => Promise<void>;
  probe: () => Promise<boolean>;
  openBrowser: (url: string) => void;
  log: (s: string) => void;
  error: (s: string) => void;
}

/**
 * Starts the server and opens the browser. Returns null while the server keeps running, or an
 * exit code when there is nothing more to do (a second launch while one already runs).
 */
export async function launch(deps: Partial<LaunchDeps> = {}): Promise<number | null> {
  const d: LaunchDeps = { start, probe: probeRunningConsole, openBrowser, log: console.log, error: console.error, ...deps };
  const port = readConfig().port;
  try {
    await d.start();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    const info = readServerInfo();
    if (info && (await d.probe())) {
      d.log(`Agent Console is already running on port ${info.port}; opening it.`);
      d.openBrowser(`http://127.0.0.1:${info.port}/auth?token=${ensureToken()}`);
      return 0;
    }
    d.error(
      `Port ${port} is already in use by another program (EADDRINUSE). ` +
        `Stop that program, or set a different "port" in ${path.join(dataDir(), 'config.json')}.`,
    );
    return 1;
  }
  d.openBrowser(`http://127.0.0.1:${port}/auth?token=${ensureToken()}`);
  return null;
}

async function main(): Promise<void> {
  const sub = process.argv[2];
  if (sub === 'install') {
    await runInstall(defaultTargets());
  } else if (sub === 'uninstall') {
    await runUninstall(defaultTargets());
  } else if (sub === undefined) {
    const code = await launch();
    if (code !== null) process.exit(code);
  } else {
    console.error(USAGE);
    process.exit(1);
  }
}

// Run only when executed directly (npm bin shims are symlinks/wrappers, so compare real paths).
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
