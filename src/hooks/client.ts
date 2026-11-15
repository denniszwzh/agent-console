import fs from 'node:fs';
import path from 'node:path';
import { dataDir, readServerInfo } from '../server/paths.js';

const TIMEOUT_MS = 2000;

/** Calls the local Agent Console server. Returns parsed JSON, or null on any failure. Never throws. */
export async function callServer(method: 'GET' | 'POST', urlPath: string, body?: unknown): Promise<unknown | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const info = readServerInfo();
    if (!info) return null;
    const token = fs.readFileSync(path.join(dataDir(), 'token'), 'utf8').trim();
    if (!token) return null;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Host: `127.0.0.1:${info.port}`,
    };
    const init: RequestInit = { method, headers, signal: ctl.signal };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`http://127.0.0.1:${info.port}${urlPath}`, init);
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Reads stdin, resolving with whatever arrived once it closes or after `ms` (default 1.5 s). */
export function readStdin(ms = 1500): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const done = () => {
      clearTimeout(timer);
      process.stdin.off('data', onData);
      process.stdin.off('end', done);
      process.stdin.off('error', done);
      process.stdin.pause();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onData = (c: Buffer) => chunks.push(c);
    const timer = setTimeout(done, ms);
    process.stdin.on('data', onData);
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}
