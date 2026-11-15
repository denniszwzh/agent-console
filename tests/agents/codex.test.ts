import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent, RunRequest } from '../../src/agents/adapter.js';
import { buildCodexArgs, codexInstruction, createCodexAdapter, createCodexQueueRunner, parseCodexStream } from '../../src/agents/codex.js';

const req: RunRequest = { parentSessionId: 'parent-1', fork: true, prompt: 'SECRET PROMPT "q" \\ x', cwd: '.' };

async function* lines(arr: string[]): AsyncIterable<string> {
  for (const l of arr) yield l;
}
async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
const fixtureLines = (name: string) =>
  fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', name), 'utf8').split('\n').filter(Boolean);

describe('buildCodexArgs', () => {
  it('forks with -s read-only placed before the subcommand', () => {
    expect(buildCodexArgs({ ...req, fork: true })).toEqual(['exec', '-s', 'read-only', '--json', 'fork', 'parent-1', '-']);
  });

  it('resumes with -s read-only placed before the subcommand', () => {
    expect(buildCodexArgs({ ...req, fork: false })).toEqual(['exec', '-s', 'read-only', '--json', 'resume', 'parent-1', '-']);
  });

  it('never puts the prompt in argv', () => {
    expect(buildCodexArgs(req).join(' ')).not.toContain('SECRET');
  });

  it('rejects ids that could be parsed as flags', () => {
    for (const bad of ['--oss', '-c', '', 'a b', 'x;y']) expect(() => buildCodexArgs({ ...req, parentSessionId: bad })).toThrow(/invalid/i);
  });
});

describe('parseCodexStream', () => {
  it('maps the fork fixture to session, text, done', async () => {
    const ev = await collect(parseCodexStream(lines(fixtureLines('codex-fork.jsonl'))));
    expect(ev).toEqual([
      { type: 'session', sessionId: '01a1dd95-f8c5-7380-8dde-9aff6533a935' },
      { type: 'text', text: 'I replied: hi' },
      { type: 'done', finalText: 'I replied: hi' },
    ]);
  });

  it('maps a plain exec and a shell run (command items ignored)', async () => {
    const exec = await collect(parseCodexStream(lines(fixtureLines('codex-exec.jsonl'))));
    expect(exec.map((e) => e.type)).toEqual(['session', 'text', 'done']);
    const shell = await collect(parseCodexStream(lines(fixtureLines('codex-exec-shell.jsonl'))));
    expect(shell[0].type).toBe('session');
    expect(shell[shell.length - 1].type).toBe('done');
    expect(shell.every((e) => e.type !== 'error')).toBe(true);
  });

  it('uses the LAST agent message as finalText when narration precedes the answer', async () => {
    const ev = await collect(parseCodexStream(lines(fixtureLines('codex-exec-apply-patch-blocked.jsonl'))));
    const texts = ev.filter((e): e is Extract<AgentEvent, { type: 'text' }> => e.type === 'text');
    expect(texts.length).toBeGreaterThan(1);
    const done = ev[ev.length - 1] as { type: string; finalText: string };
    expect(done.type).toBe('done');
    expect(done.finalText).toBe(texts[texts.length - 1].text);
  });

  it('resume reuses the parent thread id', async () => {
    const ev = await collect(parseCodexStream(lines(fixtureLines('codex-resume.jsonl'))));
    expect(ev[0]).toEqual({ type: 'session', sessionId: '01a1dd95-2d4f-7b60-99eb-5e63136a8137' });
  });

  it('emits error for turn.failed and error events, then stops', async () => {
    const failed = await collect(
      parseCodexStream(
        lines([
          JSON.stringify({ type: 'thread.started', thread_id: 't' }),
          JSON.stringify({ type: 'turn.failed', error: { message: 'rate limited' } }),
          JSON.stringify({ type: 'turn.completed' }),
        ]),
      ),
    );
    expect(failed).toEqual([
      { type: 'session', sessionId: 't' },
      { type: 'error', message: 'rate limited' },
    ]);
  });

  it('treats a transient error event as non-terminal: a later turn.completed still gives done', async () => {
    const ev = await collect(
      parseCodexStream(
        lines([
          JSON.stringify({ type: 'thread.started', thread_id: 't' }),
          JSON.stringify({ type: 'error', message: 'Reconnecting... 1/5' }),
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
          JSON.stringify({ type: 'turn.completed' }),
        ]),
      ),
    );
    expect(ev.map((e) => e.type)).toEqual(['session', 'text', 'done']);
  });

  it('reports the last error message when the stream ends without turn.completed', async () => {
    const ev = await collect(
      parseCodexStream(lines([JSON.stringify({ type: 'error', message: 'first' }), JSON.stringify({ type: 'error', message: 'boom' })])),
    );
    expect(ev).toEqual([{ type: 'error', message: 'boom' }]);
  });

  it('skips garbage and blank lines; a stream without turn.completed yields no terminal event', async () => {
    const ev = await collect(parseCodexStream(lines(['', 'garbage', '{"type":', JSON.stringify({ type: 'thread.started', thread_id: 't' })])));
    expect(ev).toEqual([{ type: 'session', sessionId: 't' }]);
  });
});

describe('createCodexAdapter.run', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-codex-'));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  function fake(body: string) {
    const file = path.join(home, 'fake-codex.mjs');
    fs.writeFileSync(file, body);
    return createCodexAdapter({ bin: process.execPath, binArgs: [file] });
  }

  it('is a codex adapter', () => {
    expect(createCodexAdapter().kind).toBe('codex');
  });

  it('passes the prompt via stdin, sets AGENT_CONSOLE_FORK, and streams events', async () => {
    const adapter = fake(`
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => (data += c));
      process.stdin.on('end', () => {
        const text = JSON.stringify({ stdin: data, fork: process.env.AGENT_CONSOLE_FORK, argv: process.argv.slice(2) });
        console.log(JSON.stringify({ type: 'thread.started', thread_id: 'new-id' }));
        console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }));
        console.log(JSON.stringify({ type: 'turn.completed' }));
      });`);
    const prompt = '請逐字重複：「引號"與\\反斜線」\n第二行';
    const ev = await collect(adapter.run({ parentSessionId: 'p', fork: true, prompt, cwd: home }));
    expect(ev.map((e) => e.type)).toEqual(['session', 'text', 'done']);
    expect(ev[0]).toEqual({ type: 'session', sessionId: 'new-id' });
    const got = JSON.parse((ev[2] as { finalText: string }).finalText);
    expect(got.stdin).toBe(prompt);
    expect(got.fork).toBe('1');
    expect(got.argv).toEqual(['exec', '-s', 'read-only', '--json', 'fork', 'p', '-']);
  });

  it('ignores stderr noise when the run succeeds', async () => {
    const adapter = fake(`
      console.error('ERROR codex_api::endpoint::responses_websocket: failed to connect');
      console.log(JSON.stringify({ type: 'thread.started', thread_id: 'i' }));
      console.log(JSON.stringify({ type: 'turn.completed' }));`);
    const ev = await collect(adapter.run({ parentSessionId: 'p', fork: false, prompt: 'x', cwd: home }));
    expect(ev[ev.length - 1]).toEqual({ type: 'done', finalText: '' });
  });

  it('emits an error with the stderr tail on a non-zero exit without a turn', async () => {
    const adapter = fake(`console.error('kaboom'); process.exit(3);`);
    const ev = await collect(adapter.run({ parentSessionId: 'p', fork: true, prompt: 'x', cwd: home }));
    const last = ev[ev.length - 1] as { type: string; message: string };
    expect(last.type).toBe('error');
    expect(last.message).toContain('kaboom');
    expect(last.message).toContain('3');
  });

  it('emits an error when the exit is non-zero even after turn.completed', async () => {
    const adapter = fake(`
      console.log(JSON.stringify({ type: 'turn.completed' }));
      process.exitCode = 1;`);
    const ev = await collect(adapter.run({ parentSessionId: 'p', fork: true, prompt: 'x', cwd: home }));
    expect(ev[ev.length - 1].type).toBe('error');
    expect(ev.some((e) => e.type === 'done')).toBe(false);
  });

  it('emits an error when the stream ends without turn.completed', async () => {
    const adapter = fake(`console.log(JSON.stringify({ type: 'thread.started', thread_id: 'i' }));`);
    const ev = await collect(adapter.run({ parentSessionId: 'p', fork: true, prompt: 'x', cwd: home }));
    expect(ev[ev.length - 1].type).toBe('error');
  });

  it('emits an error when the binary cannot be spawned', async () => {
    const adapter = createCodexAdapter({ bin: path.join(home, 'no-such-binary') });
    const ev = await collect(adapter.run({ parentSessionId: 'p', fork: true, prompt: 'x', cwd: home }));
    expect(ev[ev.length - 1].type).toBe('error');
  });

  it('reports an invalid parent id as an error event instead of spawning', async () => {
    const adapter = createCodexAdapter({ bin: path.join(home, 'no-such-binary') });
    const ev = await collect(adapter.run({ parentSessionId: '--oss', fork: true, prompt: 'x', cwd: home }));
    expect(ev).toHaveLength(1);
    expect(ev[0].type).toBe('error');
  });

  it('kills the child and reports aborted', async () => {
    const adapter = fake(`setInterval(() => {}, 1000);`);
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 300);
    const ev = await collect(adapter.run({ parentSessionId: 'p', fork: true, prompt: 'x', cwd: home }, ctl.signal));
    expect(ev[ev.length - 1]).toEqual({ type: 'error', message: 'aborted' });
  });
});

describe('codexInstruction', () => {
  it('has the documented English wording', () => {
    expect(codexInstruction('C:/h/conclusions/u1.md')).toBe('Read the review conclusions in C:/h/conclusions/u1.md and apply them.');
  });
});

describe('createCodexQueueRunner', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-cq-'));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
  const fake = (body: string, timeoutMs?: number) => {
    const file = path.join(home, 'fake-codex.mjs');
    fs.writeFileSync(file, body);
    return createCodexQueueRunner({ bin: process.execPath, binArgs: [file], timeoutMs });
  };

  it('passes thread and message as arguments and resolves true on exit 0', async () => {
    const out = path.join(home, 'argv.json');
    const run = fake(`import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));`);
    expect(await run('thr-1', 'hello "x"')).toBe(true);
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toEqual(['queue', '--thread', 'thr-1', '--message', 'hello "x"']);
  });

  it('sets AGENT_CONSOLE_FORK=1 for the queue child', async () => {
    const out = path.join(home, 'env.txt');
    const run = fake(`import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(out)}, String(process.env.AGENT_CONSOLE_FORK));`);
    expect(await run('t', 'm')).toBe(true);
    expect(fs.readFileSync(out, 'utf8')).toBe('1');
  });

  it('resolves false without spawning for a flag-like thread id', async () => {
    const out = path.join(home, 'ran.txt');
    const run = fake(`import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(out)}, 'x');`);
    expect(await run('--resume', 'm')).toBe(false);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('resolves false (never rejects) on non-zero exit, spawn failure and timeout', async () => {
    expect(await fake('process.exit(2);')('t', 'm')).toBe(false);
    expect(await createCodexQueueRunner({ bin: path.join(home, 'nope') })('t', 'm')).toBe(false);
    expect(await fake('setInterval(() => {}, 1000);', 300)('t', 'm')).toBe(false);
  });
});
