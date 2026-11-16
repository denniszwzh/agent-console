import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexInstruction } from '../../src/agents/codex.js';
import { cleanPromptText, promptsInWindow, readUserPrompts } from '../../src/server/turn-prompts.js';
import type { TurnPrompt } from '../../src/shared/types.js';

const line = (obj: unknown) => `${JSON.stringify(obj)}\n`;
const claudeUser = (content: unknown, extra: Record<string, unknown> = {}) =>
  line({ type: 'user', timestamp: '2026-11-16T00:30:00.000Z', message: { role: 'user', content }, ...extra });
const codexUser = (text: string, timestamp = '2026-11-16T00:30:00.000Z') =>
  line({ timestamp, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ac-prompts-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('cleanPromptText', () => {
  it('drops injected messages and keeps typed text', () => {
    expect(cleanPromptText('<system-reminder>\nx\n</system-reminder>')).toBeUndefined();
    expect(cleanPromptText('<task-notification>\n<task-id>1</task-id>')).toBeUndefined();
    expect(cleanPromptText('<command-name>/compact</command-name>')).toBeUndefined();
    expect(cleanPromptText('<local-command-stdout>ok</local-command-stdout>')).toBeUndefined();
    expect(cleanPromptText('<environment_context>\n  <cwd>C:\\x</cwd>')).toBeUndefined();
    expect(cleanPromptText('<turn_aborted>\nThe user interrupted')).toBeUndefined();
    expect(cleanPromptText('# AGENTS.md instructions for C:\\x')).toBeUndefined();
    expect(cleanPromptText('[Request interrupted by user]')).toBeUndefined();
    expect(cleanPromptText('   ')).toBeUndefined();
    expect(cleanPromptText('  修正錯誤  ')).toBe('修正錯誤');
  });

  it('drops shell-mode, IDE and memory messages', () => {
    for (const tag of ['bash-input', 'bash-stdout', 'bash-stderr', 'ide_opened_file', 'ide_selection', 'ide_diagnostics', 'user-memory-input']) {
      expect(cleanPromptText(`<${tag}>x</${tag}>`), tag).toBeUndefined();
    }
  });

  it('strips reminders inside a prompt and unwraps pasted content', () => {
    expect(cleanPromptText('看這個\n<system-reminder>\nnoise\n</system-reminder>')).toBe('看這個');
    expect(cleanPromptText('<pasted_content id="6017">\n貼上的需求\n</pasted_content>\n補充')).toBe('貼上的需求\n\n補充');
    expect(cleanPromptText('<!-- reply 1 -->\n> 引用')).toBe('<!-- reply 1 -->\n> 引用');
  });
});

describe('readUserPrompts (Claude)', () => {
  it('reads Claude prompts and skips injected text', async () => {
    const f = join(root, 'c.jsonl');
    writeFileSync(
      f,
      claudeUser('<system-reminder>x</system-reminder>') +
        claudeUser([{ type: 'tool_result', content: 'ignored' }]) +
        claudeUser('meta text', { isMeta: true }) +
        claudeUser('This session is being continued from a previous conversation', { isCompactSummary: true }) +
        claudeUser('only in transcript', { isVisibleInTranscriptOnly: true }) +
        claudeUser('from another session', { origin: { kind: 'peer' } }) +
        claudeUser('system prompt', { promptSource: 'system' }) +
        claudeUser('side', { isSidechain: true }) +
        claudeUser('[Request interrupted by user]') +
        line({ type: 'user', timestamp: '2026-11-16T01:00:00Z', origin: { kind: 'human' }, message: { content: '幫我看 README\n細節' } }) +
        line({
          type: 'user',
          timestamp: '2026-11-16T02:00:00.000Z',
          message: { content: [{ type: 'text', text: '<system-reminder>x</system-reminder>' }, { type: 'text', text: '修正錯誤' }] },
        }) +
        line({ type: 'assistant', timestamp: '2026-11-16T02:01:00.000Z', message: { content: [{ type: 'text', text: 'done' }] } }),
    );
    expect(await readUserPrompts('claude', f)).toEqual([
      { text: '幫我看 README\n細節', at: '2026-11-16T01:00:00Z' },
      { text: '修正錯誤', at: '2026-11-16T02:00:00.000Z' },
    ]);
  });

  it('streams the file', async () => {
    const f = join(root, 'c.jsonl');
    writeFileSync(f, claudeUser('hi'));
    const stream = vi.spyOn(fs, 'createReadStream');
    const whole = vi.spyOn(fs, 'readFileSync');
    expect(await readUserPrompts('claude', f)).toHaveLength(1);
    expect(stream).toHaveBeenCalled();
    expect(whole).not.toHaveBeenCalled();
  });
});

describe('readUserPrompts (Codex)', () => {
  it('reads Codex prompts and marks the delivery instruction', async () => {
    const f = join(root, 'x.jsonl');
    writeFileSync(
      f,
      codexUser('<environment_context>\n  <cwd>C:\\x</cwd>') +
        codexUser('# AGENTS.md instructions for C:\\x\n\n<INSTRUCTIONS>\n</INSTRUCTIONS>') +
        codexUser('整理 README', '2026-11-16T01:00:00.000Z') +
        codexUser(codexInstruction('C:\\a\\b.md'), '2026-11-16T02:00:00.000Z'),
    );
    expect(await readUserPrompts('codex', f)).toEqual([
      { text: '整理 README', at: '2026-11-16T01:00:00.000Z' },
      { text: codexInstruction('C:\\a\\b.md'), at: '2026-11-16T02:00:00.000Z', delivery: true },
    ]);
  });
});

describe('readUserPrompts failures', () => {
  it('returns [] for a missing file and null for an unreadable one', async () => {
    expect(await readUserPrompts('claude', join(root, 'nope.jsonl'))).toEqual([]);
    const dir = join(root, 'dir.jsonl');
    mkdirSync(dir);
    expect(await readUserPrompts('claude', dir)).toBeNull();
  });

  it('skips malformed lines', async () => {
    const f = join(root, 'c.jsonl');
    writeFileSync(f, '{"type":"user", broken\n' + claudeUser('ok'));
    expect((await readUserPrompts('claude', f))?.map((p) => p.text)).toEqual(['ok']);
  });
});

describe('promptsInWindow', () => {
  const p = (text: string, at: string): TurnPrompt => ({ text, at });
  const all = [p('a', '2026-11-16T01:00:00.000Z'), p('b', '2026-11-16T02:00:00.000Z'), p('c', '2026-11-16T03:00:00.000Z')];

  it('takes prompts after the previous turn up to this one', () => {
    expect(promptsInWindow(all, '2026-11-16T01:00:00.000Z', '2026-11-16T03:00:00.000Z')).toEqual({ prompts: [all[1], all[2]], omitted: 0 });
  });

  it('takes only the last prompt for the first turn', () => {
    expect(promptsInWindow(all, undefined, '2026-11-16T02:30:00.000Z')).toEqual({ prompts: [all[1]], omitted: 0 });
  });

  it('keeps the last five', () => {
    const many = Array.from({ length: 7 }, (_, i) => p(`p${i}`, `2026-11-16T0${i + 1}:00:00.000Z`));
    const r = promptsInWindow(many, '2026-11-16T00:00:00.000Z', '2026-11-16T09:00:00.000Z');
    expect(r.prompts.map((x) => x.text)).toEqual(['p2', 'p3', 'p4', 'p5', 'p6']);
    expect(r.omitted).toBe(2);
  });

  it('returns nothing when no prompt fits', () => {
    expect(promptsInWindow(all, '2026-11-16T03:00:00.000Z', '2026-11-16T04:00:00.000Z')).toEqual({ prompts: [], omitted: 0 });
    expect(promptsInWindow(all, undefined, '2026-11-16T00:00:00.000Z')).toEqual({ prompts: [], omitted: 0 });
  });

  it('compares times by value, not as strings', () => {
    const one = [p('x', '2026-11-16T01:00:00Z')];
    expect(promptsInWindow(one, '2026-11-16T00:00:00.000Z', '2026-11-16T01:00:00.000Z').prompts).toHaveLength(1);
    expect(promptsInWindow(one, '2026-11-16T01:00:00.000Z', '2026-11-16T02:00:00.000Z').prompts).toHaveLength(0);
  });

  it('skips prompts with unparseable times', () => {
    expect(promptsInWindow([p('x', 'not a time')], undefined, '2026-11-16T01:00:00.000Z').prompts).toHaveLength(0);
  });
});
