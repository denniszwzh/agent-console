import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfig, readServerInfo, writeServerInfo } from '../../src/server/paths.js';

let home: string;
const prevHome = process.env.AGENT_CONSOLE_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-console-test-'));
  process.env.AGENT_CONSOLE_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.AGENT_CONSOLE_HOME;
  else process.env.AGENT_CONSOLE_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('readConfig', () => {
  const defaults = { port: 4317, concurrency: 3, hardGate: false, runTimeoutMs: 600_000 };

  it('returns defaults when no config file exists', () => {
    expect(readConfig()).toEqual(defaults);
  });

  it('merges a partial config over defaults', () => {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ concurrency: 5 }));
    expect(readConfig()).toEqual({ ...defaults, concurrency: 5 });
  });

  it('falls back to defaults on a corrupt file', () => {
    fs.writeFileSync(path.join(home, 'config.json'), '{oops');
    expect(readConfig()).toEqual(defaults);
  });
});

describe('server info', () => {
  it('round-trips the port', () => {
    expect(readServerInfo()).toBeNull();
    writeServerInfo(5000);
    expect(readServerInfo()).toEqual({ port: 5000 });
  });
});
