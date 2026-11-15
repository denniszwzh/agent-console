import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../shared/types.js';

const DEFAULT_CONFIG: Config = { port: 4317, concurrency: 3, hardGate: false, runTimeoutMs: 600_000 };

/** Data directory; AGENT_CONSOLE_HOME overrides the default ~/.agent-console. */
export function dataDir(): string {
  const dir = process.env.AGENT_CONSOLE_HOME || path.join(os.homedir(), '.agent-console');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isCode(e: unknown, code: string): boolean {
  return (e as NodeJS.ErrnoException)?.code === code;
}

function readTokenFile(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8').trim() || null;
  } catch (e) {
    if (isCode(e, 'ENOENT')) return null;
    throw e;
  }
}

export function ensureToken(): string {
  const file = path.join(dataDir(), 'token');
  const existing = readTokenFile(file);
  if (existing) return existing;
  const token = crypto.randomBytes(32).toString('hex');
  try {
    // 'wx' makes creation race-safe. Mode 0o600 has no effect on Windows.
    fs.writeFileSync(file, token, { mode: 0o600, flag: 'wx' });
    return token;
  } catch (e) {
    if (!isCode(e, 'EEXIST')) throw e;
  }
  // Another process created the file first (or it exists but is empty).
  const winner = readTokenFile(file);
  if (winner) return winner;
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

/** Absolute path of a unit's conclusion bundle file (its directory is created on demand). */
export function conclusionFile(unitId: string): string {
  const dir = path.join(dataDir(), 'conclusions');
  fs.mkdirSync(dir, { recursive: true });
  return path.resolve(dir, `${unitId}.md`);
}
