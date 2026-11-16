import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findChangedFilesCodex } from '../../src/server/rollout.js';

const blocked = path.join(import.meta.dirname, '..', 'fixtures', 'codex-rollout-apply-patch-blocked.jsonl');

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-rollout-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const rec = (type: string, payload: object) => JSON.stringify({ timestamp: 't', ordinal: 0, type, payload });
const started = () => rec('event_msg', { type: 'task_started' });
const user = (text: string) => rec('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const patch = (callId: string, body: string) =>
  rec('response_item', { type: 'custom_tool_call', status: 'completed', call_id: callId, name: 'apply_patch', input: `*** Begin Patch\n${body}\n*** End Patch` });
const output = (callId: string, text: string) => rec('response_item', { type: 'custom_tool_call_output', call_id: callId, output: text });
function write(lines: string[]): string {
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

describe('findChangedFilesCodex', () => {
  it('ignores a patch the read-only sandbox rejected (real fixture)', () => {
    expect(findChangedFilesCodex(blocked)).toEqual([]);
  });

  it('collects Add / Update / Delete / Move paths in first-seen order, deduplicated', () => {
    const file = write([
      started(),
      user('go'),
      patch('c1', '*** Add File: a.txt\n+x'),
      output('c1', 'Success. Updated the following files:\nA a.txt'),
      patch('c2', '*** Update File: src/b.ts\n*** Move to: src/c.ts\n@@\n-1\n+2\n*** Delete File: old.md'),
      output('c2', 'Success. Updated the following files:\nM src/c.ts'),
      patch('c3', '*** Update File: a.txt\n@@\n-x\n+y'),
    ]);
    expect(findChangedFilesCodex(file)).toEqual(['a.txt', 'src/b.ts', 'src/c.ts', 'old.md']);
  });

  it('reads FileChange items for a patch applied from code mode (real fixture, trimmed)', () => {
    const codeMode = path.join(import.meta.dirname, '..', 'fixtures', 'codex-rollout-code-mode-file-change.jsonl');
    expect(findChangedFilesCodex(codeMode)).toEqual(['C:\\repo\\docs\\design.md']);
  });

  it('prefers FileChange items: completed only, move destination, last turn only, no double count with patch text', () => {
    const change = (status: string, changes: object) =>
      rec('event_msg', { type: 'item_completed', item: { type: 'FileChange', id: 'x', status, changes } });
    const file = write([
      started(),
      user('first'),
      change('completed', { 'C:\\r\\old.md': { type: 'add' } }),
      started(),
      user('second'),
      patch('c1', '*** Add File: a.md\n+x'),
      change('completed', { 'C:\\r\\a.md': { type: 'add', content: 'x' } }),
      change('failed', { 'C:\\r\\nope.md': { type: 'add' } }),
      change('completed', { 'C:\\r\\b.ts': { type: 'update', move_path: 'C:\\r\\c.ts' }, 'C:\\r\\d.ts': { type: 'update', move_path: null } }),
      change('completed', { 'C:\\r\\a.md': { type: 'update' } }),
    ]);
    expect(findChangedFilesCodex(file)).toEqual(['C:\\r\\a.md', 'C:\\r\\c.ts', 'C:\\r\\d.ts']);
  });

  it('only scans the last turn', () => {
    const file = write([
      started(),
      user('first'),
      patch('c1', '*** Add File: old.txt\n+x'),
      started(),
      user('second'),
      patch('c2', '*** Add File: new.txt\n+x'),
    ]);
    expect(findChangedFilesCodex(file)).toEqual(['new.txt']);
  });

  it('falls back to the last user message when there is no task_started', () => {
    const file = write([user('first'), patch('c1', '*** Add File: old.txt\n+x'), user('second'), patch('c2', '*** Add File: new.txt\n+x')]);
    expect(findChangedFilesCodex(file)).toEqual(['new.txt']);
  });

  it('skips only the failed call, and ignores other tools', () => {
    const file = write([
      started(),
      patch('c1', '*** Add File: bad.txt\n+x'),
      output('c1', 'patch failed: could not apply'),
      patch('c2', '*** Add File: good.txt\n+x'),
      output('c2', 'Success. Updated the following files:\nA good.txt'),
      rec('response_item', { type: 'custom_tool_call', call_id: 'c3', name: 'other_tool', input: '*** Add File: nope.txt' }),
    ]);
    expect(findChangedFilesCodex(file)).toEqual(['good.txt']);
  });

  it('never throws: missing file, garbage lines', () => {
    expect(findChangedFilesCodex(path.join(dir, 'missing.jsonl'))).toEqual([]);
    expect(findChangedFilesCodex(write(['not json', '{"type":', '42']))).toEqual([]);
  });
});
