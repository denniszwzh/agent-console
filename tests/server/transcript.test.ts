import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChangedFilesClaude } from '../../src/server/transcript.js';

const fixture = fileURLToPath(new URL('../fixtures/claude-transcript-basic.jsonl', import.meta.url));

describe('findChangedFilesClaude', () => {
  it('returns files changed since the last real user prompt, deduplicated', () => {
    expect(findChangedFilesClaude(fixture, 'sess-1')).toEqual(['a.md', 'b.ts']);
  });

  it('ignores entries from other sessions', () => {
    expect(findChangedFilesClaude(fixture, 'other')).toEqual([]);
  });

  it('skips malformed lines and unreadable files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tr-'));
    const p = join(dir, 't.jsonl');
    writeFileSync(p, [
      '{not json',
      JSON.stringify({ type: 'user', sessionId: 's', message: { content: 'hi' } }),
      JSON.stringify({ type: 'assistant', sessionId: 's', message: { content: [{ type: 'tool_use', name: 'NotebookEdit', input: { notebook_path: 'n.ipynb' } }] } }),
    ].join('\n'));
    expect(findChangedFilesClaude(p, 's')).toEqual(['n.ipynb']);
    expect(findChangedFilesClaude(join(dir, 'missing.jsonl'), 's')).toEqual([]);
  });
});
