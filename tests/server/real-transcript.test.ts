import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTurnIn } from '../../src/server/activity-recovery.js';
import { isInterruptRecord } from '../../src/server/activity.js';
import { SessionMetaService } from '../../src/server/session-meta.js';
import { findChangedFilesClaude } from '../../src/server/transcript.js';
import { readUserPrompts } from '../../src/server/turn-prompts.js';

// A real Claude Code desktop transcript (Windows), passed through scripts/sanitize-transcript.mjs:
// two turns; the first edits three files and ends with a Stop hook, the second edits one file and
// is interrupted by the user during a tool call.
const fixture = path.join(import.meta.dirname, '..', 'fixtures', 'claude-transcript-sanitized-real.jsonl');
const SESSION = 'cafdfecf-04e7-4ac1-8dbb-4321edf4cea5';
const PROMPT_1 = '2026-11-25T13:49:09.962Z';
const PROMPT_2 = '2026-11-25T20:26:16.276Z';
const MEMORY = 'C:\\Users\\D1\\.claude\\projects\\D12\\d13\\';

const lines = fs
  .readFileSync(fixture, 'utf8')
  .split('\n')
  .filter((l) => l.trim());
const indexOf = (pred: (r: any) => boolean) => lines.findIndex((l) => pred(JSON.parse(l)));
/** Line of the Stop hook summary that ends turn 1, and of the interrupt notice that ends turn 2. */
const turn1End = indexOf((r) => r.type === 'system' && r.subtype === 'stop_hook_summary');
const interrupt = lines.findIndex(isInterruptRecord);

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-real-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function head(n: number): string {
  const file = path.join(dir, 'head.jsonl');
  fs.writeFileSync(file, lines.slice(0, n).join('\n') + '\n');
  return file;
}

describe('real Claude Code transcript (sanitized)', () => {
  it('has the expected turn boundaries', () => {
    const prompt2 = indexOf((r) => r.timestamp === PROMPT_2);
    expect(turn1End).toBeGreaterThan(0);
    expect(prompt2).toBeGreaterThan(turn1End);
    expect(interrupt).toBeGreaterThan(prompt2);
    expect(lines.filter(isInterruptRecord)).toHaveLength(1);
  });

  it('reads only the two prompts the user typed (meta, tool results and the interrupt are left out)', async () => {
    const prompts = await readUserPrompts('claude', fixture);
    expect(prompts!.map((p) => [p.at, p.delivery])).toEqual([
      [PROMPT_1, undefined],
      [PROMPT_2, undefined],
    ]);
  });

  it('takes the session title from custom-title and the start time from the first record', () => {
    const home = path.join(dir, 'claude');
    fs.mkdirSync(path.join(home, 'projects', 'p'), { recursive: true });
    fs.copyFileSync(fixture, path.join(home, 'projects', 'p', `${SESSION}.jsonl`));
    const meta = new SessionMetaService({ claudeHome: home, codexHome: path.join(dir, 'codex') }).describe('claude', SESSION);
    expect(meta.titleSource).toBe('agent');
    expect(meta.title).toBeTruthy();
    expect(meta.createdAt).toBe('2026-11-25T13:49:08.759Z');
  });

  it('lists the files turn 1 edited, in first-seen order', () => {
    expect(findChangedFilesClaude(head(turn1End + 1), SESSION)).toEqual([
      'C:\\Users\\D1\\AppData\\Local\\Temp\\d4\\d5\\d6\\d7\\d25.py',
      `${MEMORY}d32.md`,
      `${MEMORY}D13.md`,
    ]);
  });

  it('lists the file turn 2 edited before it was interrupted', () => {
    expect(findChangedFilesClaude(head(interrupt), SESSION)).toEqual([`${MEMORY}d32.md`]);
  });

  it('sees no running turn after the Stop hook or the interrupt', () => {
    expect(openTurnIn('claude', lines.slice(0, turn1End + 1))).toBeUndefined();
    expect(openTurnIn('claude', lines)).toBeUndefined();
  });

  it('recovers turn 2 as running while it is in progress', () => {
    const turn = openTurnIn('claude', lines.slice(0, interrupt));
    expect(turn?.since).toBe(PROMPT_2);
    expect(turn?.prompt).toBeTruthy();
  });
});
