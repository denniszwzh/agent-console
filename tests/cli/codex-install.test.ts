import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CODEX_TRUST_NOTICE, codexHookCommands, runInstall, runUninstall } from '../../src/cli/main.js';
import { addCodexHooks, assertRecognisable, removeHooks } from '../../src/cli/settings-merge.js';

const cmd = {
  Stop: 'node "C:\\x\\agent-console\\dist\\hooks\\codex-stop.js"',
  UserPromptSubmit: 'node "C:\\x\\agent-console\\dist\\hooks\\codex-activity.js"',
  Interrupt: 'node "C:\\x\\agent-console\\dist\\hooks\\codex-activity.js"',
};
let dir: string;
let claude: string;
let codexDir: string;
let hooksFile: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-cxi-'));
  claude = path.join(dir, 'claude', 'settings.json');
  codexDir = path.join(dir, 'codex');
  hooksFile = path.join(codexDir, 'hooks.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('codex hooks.json merge', () => {
  const other = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node other.js' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node p.js' }] }] } };

  it('adds Stop, UserPromptSubmit and Interrupt (with a 3 s timeout) and keeps everything else', () => {
    const out = addCodexHooks(other, cmd) as { hooks: Record<string, unknown[]> };
    expect(Object.keys(out.hooks).sort()).toEqual(['Interrupt', 'PreToolUse', 'Stop', 'UserPromptSubmit']);
    expect(out.hooks.Stop).toHaveLength(2);
    expect(out.hooks.Stop[1]).toEqual({ hooks: [{ type: 'command', command: cmd.Stop }] });
    expect(out.hooks.UserPromptSubmit).toEqual([{ hooks: [{ type: 'command', command: cmd.UserPromptSubmit }] }]);
    expect(out.hooks.Interrupt).toEqual([{ hooks: [{ type: 'command', command: cmd.Interrupt, timeout: 3 }] }]);
    expect(out.hooks.PreToolUse).toEqual(other.hooks.PreToolUse);
  });

  it('upgrades a Stop-only install without duplicating the Stop hook', () => {
    const stopOnly = { hooks: { Stop: [{ hooks: [{ type: 'command', command: cmd.Stop }] }] } };
    const out = addCodexHooks(stopOnly, cmd) as { hooks: Record<string, unknown[]> };
    expect(out.hooks.Stop).toEqual(stopOnly.hooks.Stop);
    expect(out.hooks.UserPromptSubmit).toHaveLength(1);
    expect(out.hooks.Interrupt).toHaveLength(1);
  });

  it('is idempotent and removeHooks restores the original', () => {
    const once = addCodexHooks(other, cmd);
    expect(addCodexHooks(once, cmd)).toEqual(once);
    expect(removeHooks(once)).toEqual(other);
    expect(removeHooks(addCodexHooks({}, cmd))).toEqual({ hooks: {} });
  });

  it('refuses a non-object hooks value, and an unrecognisable command', () => {
    expect(() => addCodexHooks({ hooks: [] }, cmd)).toThrow(/not an object/);
    expect(() => assertRecognisable({ Stop: 'node "C:\\elsewhere\\codex-stop.js"' })).toThrow(/agent-console/);
  });

  it('builds a recognisable command from the real script path', () => {
    expect(() => assertRecognisable(codexHookCommands())).not.toThrow();
    expect(codexHookCommands().Stop).toMatch(/hooks[\\/]codex-stop\.js/);
    expect(codexHookCommands().UserPromptSubmit).toMatch(/hooks[\\/]codex-activity\.js/);
    expect(codexHookCommands().Interrupt).toBe(codexHookCommands().UserPromptSubmit);
  });
});

describe('runInstall / runUninstall (temp dirs only)', () => {
  const quiet = () => {};

  it('skips Codex with a note when its directory does not exist', async () => {
    const logs: string[] = [];
    await runInstall({ claudeSettings: claude, codexDir }, async () => true, (s) => logs.push(s));
    expect(fs.existsSync(claude)).toBe(true);
    expect(fs.existsSync(codexDir)).toBe(false);
    expect(logs.some((l) => l.startsWith('Skipping Codex'))).toBe(true);
  });

  it('writes hooks.json after a separate confirmation, with backup and trust notice', async () => {
    fs.mkdirSync(codexDir, { recursive: true });
    const orig = { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node p.js' }] }] } };
    fs.writeFileSync(hooksFile, JSON.stringify(orig));
    const questions: string[] = [];
    const logs: string[] = [];
    await runInstall({ claudeSettings: claude, codexDir }, async (q) => (questions.push(q), true), (s) => logs.push(s));
    expect(questions).toHaveLength(2); // Claude, then Codex
    const written = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
    expect(written).toEqual(addCodexHooks(orig, codexHookCommands()));
    expect(written.hooks.UserPromptSubmit[0].hooks[0].command).toContain('codex-activity.js');
    const backups = fs.readdirSync(codexDir).filter((f) => f.startsWith('hooks.json.agent-console-backup-'));
    expect(backups).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(codexDir, backups[0]), 'utf8'))).toEqual(orig);
    expect(logs).toContain(CODEX_TRUST_NOTICE);
    expect(CODEX_TRUST_NOTICE).toContain('/hooks');
  });

  it('prints the trust notice even when the hook is already installed (nothing to change)', async () => {
    fs.mkdirSync(codexDir, { recursive: true });
    await runInstall({ claudeSettings: claude, codexDir }, async () => true, () => {});
    const logs: string[] = [];
    await runInstall({ claudeSettings: claude, codexDir }, async () => true, (s) => logs.push(s));
    expect(logs).toContain('Nothing to change.');
    expect(logs).toContain(CODEX_TRUST_NOTICE);
  });

  it('names the offending file in the hooks-shape error', async () => {
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(hooksFile, JSON.stringify({ hooks: [] }));
    await expect(runInstall({ claudeSettings: claude, codexDir }, async () => true, () => {})).rejects.toThrow(/"hooks" in hooks.json/);
  });

  it('declining the Codex change leaves hooks.json untouched and prints no trust notice', async () => {
    fs.mkdirSync(codexDir, { recursive: true });
    const logs: string[] = [];
    let n = 0;
    await runInstall({ claudeSettings: claude, codexDir }, async () => ++n === 1, (s) => logs.push(s));
    expect(fs.existsSync(hooksFile)).toBe(false);
    expect(logs).not.toContain(CODEX_TRUST_NOTICE);
  });

  it('uninstall removes our Codex hook and skips a missing directory', async () => {
    fs.mkdirSync(codexDir, { recursive: true });
    await runInstall({ claudeSettings: claude, codexDir }, async () => true, quiet);
    await runUninstall({ claudeSettings: claude, codexDir }, async () => true, quiet);
    expect(JSON.parse(fs.readFileSync(hooksFile, 'utf8'))).toEqual({ hooks: {} });
    const logs: string[] = [];
    await runUninstall({ claudeSettings: claude, codexDir: path.join(dir, 'nope') }, async () => true, (s) => logs.push(s));
    expect(logs.some((l) => l.startsWith('Skipping Codex'))).toBe(true);
  });
});
