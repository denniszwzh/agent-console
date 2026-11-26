import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without type declarations
import { createSanitizer, INJECTED_TAGS as SCRIPT_TAGS } from '../../scripts/sanitize-transcript.mjs';
import { isCodexInstruction } from '../../src/agents/codex.js';
import { findChangedFilesCodex } from '../../src/server/rollout.js';
import { findChangedFilesClaude } from '../../src/server/transcript.js';
import { cleanPromptText, INJECTED_TAGS, readUserPrompts } from '../../src/server/turn-prompts.js';

const fixtures = path.join(import.meta.dirname, '..', 'fixtures');
const jsonlFixtures = fs.readdirSync(fixtures).filter((f) => f.endsWith('.jsonl'));

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-sanitize-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

type Sanitizer = { line: (l: string) => string; value: (v: unknown) => any; sanitizePath: (p: string) => string };

function sanitizeFile(s: Sanitizer, src: string): string {
  const out = path.join(dir, `sanitized-${path.basename(src)}`);
  const lines = fs.readFileSync(src, 'utf8').split('\n');
  fs.writeFileSync(out, lines.map((l) => s.line(l.replace(/\r$/, ''))).join('\n'));
  return out;
}

const one = (v: unknown, opts?: { maxText?: number }) => (createSanitizer(opts) as Sanitizer).value(v);

describe('sanitize-transcript keeps what the parsers read (real fixtures)', () => {
  it.each(jsonlFixtures)('%s: same records, record types and prompts', async (name) => {
    // Real transcripts are compact JSON, as is the sanitizer's output; some hand-written fixtures
    // are not, and the prompt reader's line filter depends on that. Compare against a compact copy.
    const src = path.join(dir, name);
    const compact = (l: string) => (l.trim() ? JSON.stringify(JSON.parse(l)) : l);
    fs.writeFileSync(src, fs.readFileSync(path.join(fixtures, name), 'utf8').split('\n').map(compact).join('\n'));
    const out = sanitizeFile(createSanitizer(), src);
    const parse = (f: string) =>
      fs
        .readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
    const a = parse(src);
    const b = parse(out);
    expect(b.length).toBe(a.length);
    const types = (r: any) => [r.type, r.payload?.type, r.payload?.role, r.message?.role, r.sessionId, r.timestamp];
    expect(b.map(types)).toEqual(a.map(types));
    for (const agent of ['claude', 'codex'] as const) {
      const pa = (await readUserPrompts(agent, src))!;
      const pb = (await readUserPrompts(agent, out))!;
      expect(pb.map((p) => [p.at, p.delivery])).toEqual(pa.map((p) => [p.at, p.delivery]));
    }
  });

  it('Claude edit detection finds the same files, with mapped paths', () => {
    const src = path.join(fixtures, 'claude-transcript-basic.jsonl');
    const s = createSanitizer() as Sanitizer;
    const out = sanitizeFile(s, src);
    const before = findChangedFilesClaude(src, 'sess-1');
    expect(before.length).toBeGreaterThan(0);
    expect(findChangedFilesClaude(out, 'sess-1')).toEqual(before.map(s.sanitizePath));
  });

  it.each(['codex-rollout-apply-patch-blocked.jsonl', 'codex-rollout-code-mode-file-change.jsonl'])(
    '%s: Codex edit detection finds the same files, with mapped paths',
    (name) => {
      const src = path.join(fixtures, name);
      const s = createSanitizer() as Sanitizer;
      const out = sanitizeFile(s, src);
      expect(findChangedFilesCodex(out)).toEqual(findChangedFilesCodex(src).map(s.sanitizePath));
    },
  );
});

describe('sanitize-transcript removes private content', () => {
  it('protects every tag the prompt reader treats as injected', () => {
    expect(SCRIPT_TAGS).toEqual(expect.arrayContaining(INJECTED_TAGS));
  });

  it('masks free text but keeps its shape, injected tags and markers', () => {
    const text = '<system-reminder>Secret plan 42</system-reminder>\n我的密碼 hunter2 [Request interrupted by user]';
    const out = one({ text }).text as string;
    expect(out).toBe('<system-reminder>Xxxxxx xxxx 00</system-reminder>\n字字字字 xxxxxx0 [Request interrupted by user]');
    expect(cleanPromptText(one({ text: '<command-name>/deploy prod</command-name>' }).text)).toBeUndefined();
  });

  it('masks pasted-content attributes but keeps the wrapper', () => {
    const out = one({ t: '<pasted_content id="notes-from-alice.txt">hi</pasted_content>' }).t;
    expect(out).toBe('<pasted_content xx="xxxxx-xxxx-xxxxx.xxx">xx</pasted_content>');
    expect(cleanPromptText(out)).toBe('xx');
  });

  it('keeps ids, timestamps, enum values, numbers and booleans', () => {
    const rec = {
      type: 'assistant',
      uuid: '0b6c3b9e-2f0a-4d3e-9d55-1f9c1e0e6a11',
      sessionId: 'abc-123',
      timestamp: '2026-11-26T11:33:13.123Z',
      isSidechain: false,
      message: { role: 'assistant', model: 'claude-x-1', usage: { input_tokens: 12 }, content: [{ type: 'tool_use', id: 'toolu_01AB', name: 'Bash', input: { command: 'cat /etc/hosts' } }] },
    };
    const out = one(rec);
    expect(out).toEqual({ ...rec, message: { ...rec.message, content: [{ ...rec.message.content[0], input: { command: 'xxx /xxx/xxxxx' } }] } });
  });

  it('maps path names consistently (case-insensitively) and keeps roots, extensions, agent folders and dates', () => {
    const s = createSanitizer() as Sanitizer;
    const a = s.value({ cwd: 'C:\\Users\\Dennis\\code\\secret-app' });
    const b = s.value({ file_path: 'c:\\users\\dennis\\code\\secret-app\\src\\Main.ts' });
    expect(a.cwd).toBe('C:\\Users\\D1\\d2\\d3');
    expect(b.file_path).toBe('c:\\users\\d1\\d2\\d3\\d4\\D5.ts');
    const rollout = '/home/dennis/.codex/sessions/2026/11/15/rollout-2026-11-15T13-01-43-01a1dd95-2d4f-7b60-99eb-5e63136a8137.jsonl';
    expect(s.value({ transcript_path: rollout }).transcript_path).toBe(rollout.replace('dennis', 'd1'));
    expect(s.sanitizePath('C:/x/.claude/worktrees/feature-y')).toMatch(/^C:\/d\d+\/\.claude\/worktrees\/d\d+$/);
  });

  it('maps path keys of objects (Codex FileChange)', () => {
    const s = createSanitizer() as Sanitizer;
    const out = s.value({ changes: { '/srv/private/a.txt': { type: 'add' } } });
    expect(Object.keys(out.changes)).toEqual([s.sanitizePath('/srv/private/a.txt')]);
    expect(Object.keys(out.changes)[0]).not.toContain('private');
  });

  it('handles JSON held in a string', () => {
    const out = one({ arguments: JSON.stringify({ command: ['bash', '-lc', 'echo topsecret'], workdir: '/srv/private' }) });
    expect(JSON.parse(out.arguments)).toEqual({ command: ['xxxx', '-xx', 'xxxx xxxxxxxxx'], workdir: '/d1/d2' });
  });

  it('replaces embedded images with a tiny PNG', () => {
    const out = one({ content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'A'.repeat(5000) } }, { image_url: 'data:image/png;base64,QUJD' }] });
    expect(out.content[0].source.data.length).toBeLessThan(200);
    expect(out.content[1].image_url).toMatch(/^data:image\/png;base64,iVBOR/);
  });

  it('keeps apply_patch headers with mapped paths and trims long bodies', () => {
    const body = Array.from({ length: 20 }, (_, i) => `+line ${i}`).join('\n');
    const input = `*** Begin Patch\n*** Add File: /srv/private/a.txt\n${body}\n*** Update File: notes/b.md\n@@\n-x\n+y\n*** End Patch`;
    const s = createSanitizer() as Sanitizer;
    const out = s.value({ input }).input as string;
    const lines = out.split('\n');
    expect(lines.filter((l) => l.startsWith('*** '))).toEqual([
      '*** Begin Patch',
      `*** Add File: ${s.sanitizePath('/srv/private/a.txt')}`,
      `*** Update File: ${s.sanitizePath('notes/b.md')}`,
      '*** End Patch',
    ]);
    expect(lines).toContain('[...]');
    expect(out).not.toMatch(/private|notes|line/);
  });

  it('keeps the conclusion hand-back sentence recognisable', () => {
    const text = 'Read the review conclusions in C:\\Users\\Dennis\\.agent-console\\conclusions\\u1.md and apply them.';
    const out = one({ text }).text;
    expect(isCodexInstruction(out)).toBe(true);
    expect(out).not.toContain('Dennis');
  });

  it('cuts long text without breaking a reminder block', () => {
    const text = `<system-reminder>\n${'word '.repeat(200)}\n</system-reminder>\nmy prompt`;
    const out = one({ text }, { maxText: 50 }).text as string;
    expect(out.length).toBeLessThan(120);
    expect(out).toContain('</system-reminder>');
    expect(one({ text }, { maxText: 0 }).text.length).toBe(text.length);
  });

  it('leaves no original word of a realistic record behind', () => {
    const rec = {
      type: 'user',
      cwd: 'D:\\Work\\AcmeCorp\\payroll',
      gitBranch: 'feature/salary-review',
      message: { role: 'user', content: [{ type: 'text', text: 'Email bob@acme.example the API key sk-live-ABC123 for payroll' }] },
    };
    const out = JSON.stringify(one(rec));
    for (const word of ['Work', 'Acme', 'payroll', 'salary', 'bob', 'sk-live', 'ABC123', 'Email']) expect(out).not.toContain(word);
  });
});
