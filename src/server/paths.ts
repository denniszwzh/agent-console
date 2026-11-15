import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../shared/types.js';

const DEFAULT_CONFIG: Config = { port: 4317, concurrency: 3, hardGate: false };

/** Data directory; AGENT_CONSOLE_HOME overrides the default ~/.agent-console. */
export function dataDir(): string {
  const dir = process.env.AGENT_CONSOLE_HOME || path.join(os.homedir(), '.agent-console');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureToken(): string {
  const file = path.join(dataDir(), 'token');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // fall through and create a new token
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}

export function readConfig(): Config {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir(), 'config.json'), 'utf8'));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function writeServerInfo(port: number): void {
  fs.writeFileSync(path.join(dataDir(), 'server.json'), JSON.stringify({ port }));
}

export function readServerInfo(): { port: number } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir(), 'server.json'), 'utf8'));
    return typeof raw?.port === 'number' ? { port: raw.port } : null;
  } catch {
    return null;
  }
}
