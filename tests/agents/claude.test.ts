import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent, RunRequest } from '../../src/agents/adapter.js';
import { buildClaudeArgs, createClaudeAdapter, parseClaudeStream } from '../../src/agents/claude.js';

const req: RunRequest = { parentSessionId: 'parent-1', fork: true, prompt: 'SECRET PROMPT "q" \\ x', cwd: '.' };

async function* lines(arr: string[]): AsyncIterable<string> {
  for (const l of arr) yield l;
}
async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
const fixture = fs
  .readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'claude-stream-fork.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean);

describe('buildClaudeArgs', () => {
  it('includes --fork-session only when fork is true', () => {
    expect(buildClaudeArgs({ ...req, fork: true }, 'g.json')).toContain('--fork-session');
    expect(buildClaudeArgs({ ...req, fork: false }, 'g.json')).not.toContain('--fork-session');
  });

  it('never puts the prompt in argv', () => {
    expect(buildClaudeArgs(req, 'g.json').join(' ')).not.toContain('SECRET');
  });

  it('always locks down tools and MCP', () => {
    const a = buildClaudeArgs({ ...req, fork: false }, 'g.json');
    expect(a).toContain('--strict-mcp-config');
    expect(a).not.toContain('--mcp-config');
    expect(a[a.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,Bash,PowerShell');
    const i = a.indexOf('--disallowedTools');
    expect(a.slice(i + 1, i + 5)).toEqual(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
    expect(a[a.indexOf('--settings') + 1]).toBe('g.json');
    expect(a[a.indexOf('--permission-mode') + 1]).toBe('default');
  });

  it('keeps user-level hooks and plugins out of forks', () => {
    const a = buildClaudeArgs(req, 'g.json');
    expect(a[a.indexOf('--setting-sources') + 1]).toBe('project,local');
  });

  it('matches the documented argv shape', () => {
    expect(buildClaudeArgs(req, 'g.json')).toEqual([
      '-p', '--resume', 'parent-1', '--fork-session', '--output-format', 'stream-json', '--verbose',
      '--tools', 'Read,Grep,Glob,Bash,PowerShell',
      '--disallowedTools', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
      '--strict-mcp-config', '--permission-mode', 'default', '--settings', 'g.json',
      '--setting-sources', 'project,local',
    ]);
  });
});

describe('parseClaudeStream', () => {
  it('turns a real fork run into session, text, done', async () => {
    const ev = await collect(parseClaudeStream(lines(fixture)));
    expect(ev.map((e) => e.type)).toEqual(['session', 'text', 'done']);
    expect(ev[0]).toEqual({ type: 'session', sessionId: 'd30b440b-9fbf-4a85-9966-e4edb368ad42' });
    const text = ev[1] as { text: string };
    const done = ev[2] as { finalText: string };
    expect(text.text).toContain('blocked by agent-console read-only guard');
    expect(done.finalText).toBe(text.text);
  });

  it('emits error when result.is_error is true', async () => {
    const ev = await collect(
      parseClaudeStream(
        lines([
          JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
          JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom', session_id: 's1' }),
        ]),
      ),
    );
    expect(ev).toEqual([
      { type: 'session', sessionId: 's1' },
      { type: 'error', message: 'boom' },
    ]);
  });

  it('falls back to subtype for the error message', async () => {
    const ev = await collect(
      parseClaudeStream(lines([JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 's1' })])),
    );
    expect(ev[ev.length - 1]).toEqual({ type: 'error', message: 'error_max_turns' });
  });

  it('skips non-JSON lines and blank lines', async () => {
    const ev = await collect(
      parseClaudeStream(
        lines([
          'garbage',
          '',
          '{"type":',
          JSON.stringify({
            type: 'assistant',
            session_id: 's2',
            message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
          }),
          JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ab', session_id: 's2' }),
        ]),
      ),
    );
    expect(ev).toEqual([
      { type: 'session', sessionId: 's2' },
      { type: 'text', text: 'a\nb' },
      { type: 'done', finalText: 'ab' },
    ]);
  });

  it('ignores assistant messages without text and anything after the result', async () => {
    const ev = await collect(
      parseClaudeStream(
        lines([
          JSON.stringify({ type: 'assistant', session_id: 's3', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }),
          JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'x', session_id: 's3' }),
          JSON.stringify({ type: 'assistant', session_id: 's3', message: { content: [{ type: 'text', text: 'late' }] } }),
        ]),
      ),
    );
    expect(ev.map((e) => e.type)).toEqual(['session', 'done']);
  });
});

describe('createClaudeAdapter.run', () => {
  let home: string;
  const prev = process.env.AGENT_CONSOLE_HOME;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-claude-'));
    process.env.AGENT_CONSOLE_HOME = home;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.AGENT_CONSOLE_HOME;
    else process.env.AGENT_CONSOLE_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  });

  let guardStub: string;
  function fake(body: string) {
    guardStub = path.join(home, 'dist', 'hooks', 'claude-guard.js');
    fs.mkdirSync(path.dirname(guardStub), { recursive: true });
    fs.writeFileSync(guardStub, '');
    const file = path.join(home, 'fake-claude.mjs');
    fs.writeFileSync(file, body);
    return createClaudeAdapter({ bin: process.execPath, binArgs: [file], guardScript: guardStub });
  }

  it('writes guard-settings.json with the PreToolUse hook', () => {
    fake('');
    const s = JSON.parse(fs.readFileSync(path.join(home, 'guard-settings.json'), 'utf8'));
    expect(s.hooks.PreToolUse[0].matcher).toBe('Bash|PowerShell');
    expect(s.hooks.PreToolUse[0].hooks[0]).toEqual({ type: 'command', command: `node "${guardStub.split(path.sep).join('/')}"` });
  });

  it('re-enables hooks so a project/local "disableAllHooks": true cannot switch the guard off', () => {
    // Verified with Claude Code 2.1.302: flag settings win over project and local settings (docs/manual-test-claude.md).
    fake('');
    const s = JSON.parse(fs.readFileSync(path.join(home, 'guard-settings.json'), 'utf8'));
    expect(s.disableAllHooks).toBe(false);
  });

  it('throws when the guard script does not exist (never run unguarded)', () => {
    expect(() => createClaudeAdapter({ bin: 'x', guardScript: path.join(home, 'missing.js') })).toThrow(/guard script/i);
  });

  it('passes the prompt via stdin, sets AGENT_CONSOLE_FORK, and streams events', async () => {
    const adapter = fake(`
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => (data += c));
      process.stdin.on('end', () => {
        const text = JSON.stringify({ stdin: data, fork: process.env.AGENT_CONSOLE_FORK, locks: process.env.GIT_OPTIONAL_LOCKS, argv: process.argv.slice(2) });
        console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'new-id' }));
        console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: 'new-id' }));
      });`);
    const prompt = '請逐字重複：「引號"與\\反斜線\'」\n第二行';
    const ev = await collect(adapter.run({ parentSessionId: 'p', fork: true, prompt, cwd: home }));
    expect(ev[0]).toEqual({ type: 'session', sessionId: 'new-id' });
    const done = ev[1] as { type: string; finalText: string };
    expect(done.type).toBe('done');
    const got = JSON.parse(done.finalText);
    expect(got.stdin).toBe(prompt);
    expect(got.fork).toBe('1');
    expect(got.locks).toBe('0');
    expect(got.argv).toContain('--strict-mcp-config');
    expect(got.argv.join(' ')).not.toContain('引號');
  });

  it('emits an error with the stderr tail when the process exits without a result', async () => {
    const adapter = fake(`console.error('kaboom'); process.exit(3);`);
    const ev = await collect(adapter.run({ parentSessionId: 'p', fork: true, prompt: 'x', cwd: home }));
    const last = ev[ev.length - 1] as { type: string; message: string };
    expect(last.type).toBe('error');
    expect(last.message).toContain('kaboom');
    expect(last.message).toContain('3');
  });

  it('emits an error when the binary cannot be spawned', async () => {
    fake('');
    const adapter = createClaudeAdapter({ bin: path.join(home, 'no-such-binary'), guardScript: guardStub });
    const ev = await collect(adapter.run({ parentSessionId: 'p', fork: true, prompt: 'x', cwd: home }));
    expect(ev[ev.length - 1].type).toBe('error');
  });

  it('kills the child when the signal aborts', async () => {
    const adapter = fake(`setInterval(() => {}, 1000); process.stdin.resume();`);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const started = Date.now();
    const ev = await collect(adapter.run({ parentSessionId: 'p', fork: true, prompt: 'x', cwd: home }, ac.signal));
    expect(Date.now() - started).toBeLessThan(10000);
    expect(ev[ev.length - 1].type).toBe('error');
  });
});
