import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { forwardCodexStop } from '../../src/hooks/codex-stop.js';

describe('forwardCodexStop', () => {
  it('posts the payload to the codex stop route', async () => {
    const calls: unknown[][] = [];
    await forwardCodexStop(JSON.stringify({ session_id: 's', last_assistant_message: null }), async (...a) => (calls.push(a), null));
    expect(calls).toEqual([['POST', '/api/hooks/codex/stop', { session_id: 's', last_assistant_message: null }]]);
  });

  it('never throws on bad JSON or a failing server call', async () => {
    await expect(forwardCodexStop('not json')).resolves.toBeUndefined();
    await expect(forwardCodexStop('{}', async () => Promise.reject(new Error('x')))).resolves.toBeUndefined();
  });
});

const script = path.join(import.meta.dirname, '..', '..', 'dist', 'hooks', 'codex-stop.js');
describe.skipIf(!fs.existsSync(script))('built codex-stop.js (needs npm run build)', () => {
  const run = (input: string, env: Record<string, string> = {}) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-cxs-'));
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

  it('prints {} and exits 0 even when no server is running', () => {
    const r = run(JSON.stringify({ session_id: 's', cwd: '.' }));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({});
  });

  it('prints {} and exits 0 inside a fork and for garbage stdin', () => {
    expect(JSON.parse(run('{}', { AGENT_CONSOLE_FORK: '1' }).stdout)).toEqual({});
    const r = run('garbage');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({});
  });
});
