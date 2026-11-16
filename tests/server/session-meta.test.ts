import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs, { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexInstruction } from '../../src/agents/codex.js';
import { SessionMetaService } from '../../src/server/session-meta.js';

const line = (obj: unknown) => `${JSON.stringify(obj)}\n`;

let root: string;
let claudeHome: string;
let codexHome: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ac-meta-'));
  claudeHome = join(root, 'claude');
  codexHome = join(root, 'codex');
  mkdirSync(join(claudeHome, 'projects', 'C--proj'), { recursive: true });
  mkdirSync(join(codexHome, 'sessions', '2026', '11', '16'), { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

const svc = (now?: () => number) => new SessionMetaService({ claudeHome, codexHome, now });
const claudeFile = (id: string) => join(claudeHome, 'projects', 'C--proj', `${id}.jsonl`);
const CODEX_ID = '01a1e302-deab-7061-bd6c-10bf5e68df65';
const codexFile = () => join(codexHome, 'sessions', '2026', '11', '16', `rollout-2026-11-16T14-19-38-${CODEX_ID}.jsonl`);
const codexUser = (text: string) =>
  line({ timestamp: '2026-11-16T06:20:12.258Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const codexMeta = line({ timestamp: '2026-11-16T06:20:11.795Z', type: 'session_meta', payload: { id: CODEX_ID, timestamp: '2026-11-16T06:19:38.888Z' } });

/** Moves a file's mtime forward so a rewrite is seen as a change even within one clock tick. */
function bump(p: string, seconds: number) {
  const t = statSync(p).mtime.getTime() / 1000 + seconds;
  utimesSync(p, t, t);
}

describe('SessionMetaService (Claude)', () => {
  it('reads a Claude custom title over an ai title', () => {
    const f = claudeFile('s1');
    writeFileSync(
      f,
      line({ type: 'user', timestamp: '2026-11-15T01:00:00.000Z', message: { role: 'user', content: '<system-reminder>x</system-reminder>' } }) +
        line({ type: 'last-prompt', lastPrompt: '修正登入錯誤\n第二行' }) +
        line({ type: 'ai-title', aiTitle: 'AI 名稱' }) +
        line({ type: 'custom-title', customTitle: '自訂名稱' }),
    );
    const meta = svc().describe('claude', 's1');
    expect(meta).toMatchObject({ title: '自訂名稱', titleSource: 'agent', createdAt: '2026-11-15T01:00:00.000Z' });
    expect(meta.lastModified).toBe(statSync(f).mtime.toISOString());
  });

  it('falls back to the first prompt', () => {
    writeFileSync(
      claudeFile('s1'),
      line({ type: 'user', timestamp: '2026-11-15T01:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>..' }] } }) +
        line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ignored' }] } }) +
        line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '  幫我看 README\n細節' }] } }),
    );
    expect(svc().describe('claude', 's1')).toMatchObject({ title: '幫我看 README', titleSource: 'prompt' });
  });

  it('uses the last ai title when several exist', () => {
    writeFileSync(claudeFile('s1'), line({ type: 'ai-title', aiTitle: '舊' }) + line({ type: 'ai-title', aiTitle: '新' }));
    expect(svc().describe('claude', 's1').title).toBe('新');
  });

  it('prefers the known path', () => {
    writeFileSync(claudeFile('s1'), line({ type: 'custom-title', customTitle: 'B' }));
    const known = join(root, 'elsewhere.jsonl');
    writeFileSync(known, line({ type: 'custom-title', customTitle: 'A' }));
    expect(svc().describe('claude', 's1', known).title).toBe('A');
    expect(svc().describe('claude', 's1', join(root, 'not-a-transcript.txt')).title).toBe('B');
  });

  it('picks up a rename appended later', () => {
    const f = claudeFile('s1');
    writeFileSync(f, line({ type: 'custom-title', customTitle: '一' }));
    const s = svc();
    expect(s.describe('claude', 's1').title).toBe('一');
    appendFileSync(f, line({ type: 'custom-title', customTitle: '二' }));
    bump(f, 5);
    expect(s.describe('claude', 's1').title).toBe('二');
  });

  it('keeps a partial last line for the next read', () => {
    const f = claudeFile('s1');
    writeFileSync(f, line({ type: 'user', timestamp: '2026-11-15T01:00:00.000Z', message: { content: 'hi' } }) + '{"type":"custom-title","customTitle":"半');
    const s = svc();
    expect(s.describe('claude', 's1').title).toBe('hi');
    appendFileSync(f, '行"}\n');
    bump(f, 5);
    expect(s.describe('claude', 's1').title).toBe('半行');
  });

  it('reads only head and tail of a large transcript', () => {
    const f = claudeFile('s1');
    const filler = line({ type: 'assistant', message: { content: 'x'.repeat(1000) } });
    let body = line({ type: 'user', timestamp: '2026-11-15T01:00:00.000Z', message: { content: 'first' } });
    const count = Math.ceil((6 * 1024 * 1024) / filler.length);
    for (let i = 0; i < count; i++) body += i === Math.floor(count / 3) ? line({ type: 'custom-title', customTitle: '中間' }) : filler;
    body += line({ type: 'custom-title', customTitle: '結尾' });
    writeFileSync(f, body);
    let bytes = 0;
    const real = fs.readSync;
    vi.spyOn(fs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const n = (real as (...a: unknown[]) => number)(...args);
      bytes += n;
      return n;
    }) as typeof fs.readSync);
    const meta = svc().describe('claude', 's1');
    expect(meta).toMatchObject({ title: '結尾', createdAt: '2026-11-15T01:00:00.000Z' });
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(256 * 1024 + 4 * 1024 * 1024 + 64 * 1024);
  });

  it('caches a miss', () => {
    let now = 1_000_000;
    const s = svc(() => now);
    expect(s.describe('claude', 'late')).toEqual({});
    writeFileSync(claudeFile('late'), line({ type: 'custom-title', customTitle: '晚到' }));
    now += 4 * 60_000;
    expect(s.describe('claude', 'late')).toEqual({});
    now += 61_000;
    expect(s.describe('claude', 'late').title).toBe('晚到');
  });

  it('searches once for several missing sessions', () => {
    for (const d of ['C--a', 'C--b', 'C--c']) mkdirSync(join(claudeHome, 'projects', d));
    writeFileSync(claudeFile('here'), line({ type: 'custom-title', customTitle: '在' }));
    const real = fs.readdirSync;
    let calls = 0;
    vi.spyOn(fs, 'readdirSync').mockImplementation(((...args: Parameters<typeof fs.readdirSync>) => {
      calls++;
      return (real as (...a: unknown[]) => unknown)(...args);
    }) as typeof fs.readdirSync);
    const s = svc(() => 1_000_000);
    expect(s.describe('claude', 'gone-1')).toEqual({});
    const afterFirst = calls;
    expect(afterFirst).toBeGreaterThan(0);
    expect(s.describe('claude', 'gone-2')).toEqual({});
    expect(s.describe('claude', 'gone-3')).toEqual({});
    expect(s.describe('claude', 'here').title).toBe('在');
    expect(calls).toBe(afterFirst);
  });

  it('returns empty meta on unreadable input', () => {
    const f = claudeFile('s1');
    writeFileSync(f, 'not json\n{also not\n');
    expect(svc().describe('claude', 's1')).toEqual({ lastModified: statSync(f).mtime.toISOString() });
  });

  it('refuses unsafe session ids', () => {
    expect(svc().describe('claude', '../etc')).toEqual({});
  });
});

describe('SessionMetaService (Codex)', () => {
  it('reads a Codex thread name from the session index', () => {
    writeFileSync(codexFile(), codexMeta + codexUser('寫一份 docs/design.md'));
    writeFileSync(
      join(codexHome, 'session_index.jsonl'),
      line({ id: CODEX_ID, thread_name: '舊名', updated_at: '2026-11-16T06:00:00Z' }) +
        line({ id: 'other', thread_name: '別的' }) +
        line({ id: CODEX_ID, thread_name: '新名', updated_at: '2026-11-16T07:00:00Z' }),
    );
    expect(svc().describe('codex', CODEX_ID)).toMatchObject({ title: '新名', titleSource: 'agent', createdAt: '2026-11-16T06:19:38.888Z' });
  });

  it('falls back to the first Codex user message', () => {
    writeFileSync(codexFile(), codexMeta + codexUser('<environment_context>\n  <cwd>C:\\x</cwd>') + codexUser('寫一份 docs/design.md'));
    expect(svc().describe('codex', CODEX_ID)).toMatchObject({ title: '寫一份 docs/design.md', titleSource: 'prompt' });
  });

  it('skips the injected AGENTS.md message', () => {
    writeFileSync(
      codexFile(),
      codexMeta +
        codexUser('<environment_context>\n  <cwd>C:\\x</cwd>') +
        codexUser('# AGENTS.md instructions for C:\\x\n\n<INSTRUCTIONS>\nbe nice\n</INSTRUCTIONS>') +
        codexUser('整理 README'),
    );
    expect(svc().describe('codex', CODEX_ID)).toMatchObject({ title: '整理 README', titleSource: 'prompt' });
  });

  it('skips the Codex delivery instruction for the title', () => {
    writeFileSync(codexFile(), codexMeta + codexUser(codexInstruction('C:\\a\\b.md')) + codexUser('整理 README'));
    expect(svc().describe('codex', CODEX_ID)).toMatchObject({ title: '整理 README', titleSource: 'prompt' });
  });
});

describe('SessionMetaService prompt rules (Claude)', () => {
  it('skips a compaction summary for the title', () => {
    writeFileSync(
      claudeFile('s1'),
      line({ type: 'user', isCompactSummary: true, message: { content: 'This session is being continued from a previous conversation' } }) +
        line({ type: 'user', message: { content: '真正的提問' } }),
    );
    expect(svc().describe('claude', 's1')).toMatchObject({ title: '真正的提問', titleSource: 'prompt' });
  });

  it('uses pasted content as the title', () => {
    writeFileSync(claudeFile('s1'), line({ type: 'user', message: { content: '<pasted_content id="1">\n貼上的需求\n</pasted_content>' } }));
    expect(svc().describe('claude', 's1')).toMatchObject({ title: '貼上的需求', titleSource: 'prompt' });
  });
});

describe('SessionMetaService.transcriptFor', () => {
  it('finds a transcript and refuses unsafe ids', () => {
    writeFileSync(claudeFile('s1'), line({ type: 'custom-title', customTitle: 'x' }));
    expect(svc().transcriptFor('claude', 's1')).toBe(claudeFile('s1'));
    expect(svc().transcriptFor('claude', 'gone')).toBeUndefined();
    expect(svc().transcriptFor('claude', '../etc')).toBeUndefined();
  });
});
