import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { forwardCodexActivity } from '../../src/hooks/codex-activity.js';

type Call = [string, string, unknown];
const record = () => {
  const calls: Call[] = [];
  const post = async (m: 'GET' | 'POST', u: string, b?: unknown) => {
    calls.push([m, u, b]);
    return null;
  };
  return { calls, post };
};

describe('forwardCodexActivity', () => {
  it('posts a UserPromptSubmit as a turn start, with at most 200 prompt characters', async () => {
    const { calls, post } = record();
    await forwardCodexActivity(
      JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'thr_1',
        cwd: 'C:\\proj',
        transcript_path: 'C:\\Users\\u\\.codex\\sessions\\rollout-1.jsonl',
        prompt: 'p'.repeat(500),
        turn_id: 't1',
      }),
      post,
    );
    expect(calls).toEqual([
      [
        'POST',
        '/api/hooks/codex/prompt',
        {
          session_id: 'thr_1',
          cwd: 'C:\\proj',
          transcript_path: 'C:\\Users\\u\\.codex\\sessions\\rollout-1.jsonl',
          prompt: 'p'.repeat(200),
          turn_id: 't1',
        },
      ],
    ]);
  });

  it('posts an Interrupt as a turn end', async () => {
    const { calls, post } = record();
    await forwardCodexActivity(JSON.stringify({ hook_event_name: 'Interrupt', session_id: 'thr_1', transcript_path: null, turn_id: 't9' }), post);
    expect(calls).toEqual([['POST', '/api/hooks/codex/interrupt', { session_id: 'thr_1', turn_id: 't9' }]]);
  });

  it('ignores other events, a missing session, bad JSON and a failing server', async () => {
    const { calls, post } = record();
    await forwardCodexActivity(JSON.stringify({ hook_event_name: 'Stop', session_id: 's' }), post);
    await forwardCodexActivity(JSON.stringify({ hook_event_name: 'UserPromptSubmit' }), post);
    await forwardCodexActivity('not json', post);
    expect(calls).toEqual([]);
    await expect(
      forwardCodexActivity(JSON.stringify({ hook_event_name: 'Interrupt', session_id: 's' }), async () => Promise.reject(new Error('x'))),
    ).resolves.toBeUndefined();
  });
});

const script = path.join(import.meta.dirname, '..', '..', 'dist', 'hooks', 'codex-activity.js');
describe.skipIf(!fs.existsSync(script))('built codex-activity.js (needs npm run build)', () => {
  const run = (input: string, env: Record<string, string> = {}) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-cxa-'));
    try {
      return spawnSync(process.execPath, [script], {
        input,
        encoding: 'utf8',
        timeout: 8000,
        env: { ...process.env, AGENT_CONSOLE_HOME: home, ...env },
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  };

  // Plain stdout would be added to the model's context (UserPromptSubmit) or rejected (Interrupt).
  it('prints nothing and exits 0 for both events, with no server running', () => {
    for (const event of ['UserPromptSubmit', 'Interrupt']) {
      const started = Date.now();
      const r = run(JSON.stringify({ hook_event_name: event, session_id: 's', cwd: '.', prompt: 'hi' }));
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
      expect(Date.now() - started).toBeLessThan(3000);
    }
  });

  it('prints nothing inside a fork and for garbage stdin', () => {
    expect(run('{}', { AGENT_CONSOLE_FORK: '1' }).stdout).toBe('');
    const r = run('garbage');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});
