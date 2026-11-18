import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { ActivityTracker } from '../../src/server/activity.js';
import { EventBus } from '../../src/server/events.js';
import { startRemote } from '../../src/server/main.js';
import { RemoteAuth } from '../../src/server/remote/auth.js';
import { remoteUrls } from '../../src/server/remote/config.js';
import { setPassword } from '../../src/server/remote/password.js';
import { UnitStore } from '../../src/server/store.js';

// Generating a certificate under a loaded test run can be slow.
const CERT_TIMEOUT_MS = 20_000;
const TRUST_HINT = 'A new self-signed certificate was created; browsers that connect remotely must trust it again.';

let home: string;
let prev: string | undefined;
let logs: string[];
let started: { app: FastifyInstance; auth: RemoteAuth } | null = null;
let activity: ActivityTracker;
const log = (s: string) => logs.push(s);

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });

function deps(rawConfig: unknown) {
  const bus = new EventBus();
  activity = new ActivityTracker(bus);
  return { store: new UnitStore(), port: 4317, bus, activity, rawConfig };
}

const remote = (extra: Record<string, unknown> = {}) => ({ enabled: true, bindHost: '127.0.0.1', hostnames: ['localhost'], ...extra });

function get(port: string | number, ca: string, urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'GET', ca, servername: 'localhost', headers: { host: `localhost:${port}` } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// The certificate generator is imported lazily on first use; load it once up front.
beforeAll(async () => {
  await import('selfsigned');
}, CERT_TIMEOUT_MS);

beforeEach(() => {
  prev = process.env.AGENT_CONSOLE_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-remote-start-'));
  process.env.AGENT_CONSOLE_HOME = home;
  logs = [];
});

afterEach(async () => {
  await started?.app.close();
  started = null;
  activity?.close();
  vi.restoreAllMocks();
  if (prev === undefined) delete process.env.AGENT_CONSOLE_HOME;
  else process.env.AGENT_CONSOLE_HOME = prev;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('startRemote', () => {
  it('does nothing when remote is disabled', async () => {
    for (const raw of [undefined, { enabled: false, hostnames: ['localhost'] }]) {
      expect(await startRemote(deps(raw), log)).toBeNull();
      activity.close();
    }
    expect(logs).toEqual([]);
    expect(fs.existsSync(path.join(home, 'tls'))).toBe(false);
  });

  it('logs the reason and returns null when hostnames are empty', async () => {
    await setPassword('admin', 'correct horse battery');
    expect(await startRemote(deps(remote({ hostnames: [] })), log)).toBeNull();
    expect(logs).toEqual(['Remote access is off: remote.hostnames must be a non-empty array of host names']);
  });

  it('logs the reason and returns null when no password is set', async () => {
    const close = vi.spyOn(RemoteAuth.prototype, 'close');
    expect(await startRemote(deps(remote({ port: await freePort() })), log)).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^Remote access is off: /);
    expect(logs[0]).toContain('agent-console set-password');
    expect(close).toHaveBeenCalledTimes(1);
    // The password check comes before the certificate is created.
    expect(fs.existsSync(path.join(home, 'tls'))).toBe(false);
  });

  it('logs the reason and returns null when only certFile is given', async () => {
    await setPassword('admin', 'correct horse battery');
    expect(await startRemote(deps(remote({ certFile: path.join(home, 'cert.pem') })), log)).toBeNull();
    expect(logs).toEqual(['Remote access is off: remote.certFile and remote.keyFile must be set together']);
  });

  it('logs the reason and returns null when the configured certificate cannot be read', async () => {
    await setPassword('admin', 'correct horse battery');
    const close = vi.spyOn(RemoteAuth.prototype, 'close');
    const certFile = path.join(home, 'missing-cert.pem');
    const keyFile = path.join(home, 'missing-key.pem');
    expect(await startRemote(deps(remote({ certFile, keyFile })), log)).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(new RegExp(`^Remote access is off: Cannot read remote\\.certFile ${certFile.replace(/[\\.]/g, '\\$&')}`));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('logs the reason and returns null when the port is taken', async () => {
    await setPassword('admin', 'correct horse battery');
    const close = vi.spyOn(RemoteAuth.prototype, 'close');
    const blocker = net.createServer();
    const port = await new Promise<number>((resolve) => {
      blocker.listen(0, '127.0.0.1', () => resolve((blocker.address() as net.AddressInfo).port));
    });
    try {
      expect(await startRemote(deps(remote({ port })), log)).toBeNull();
    } finally {
      await new Promise((r) => blocker.close(r));
    }
    expect(logs.at(-1)).toBe(`Remote access is off: port ${port} is already in use`);
    expect(logs.some((l) => l.startsWith('Remote access: '))).toBe(false);
    expect(close).toHaveBeenCalled();
  }, CERT_TIMEOUT_MS);

  it('serves https with the self-signed cert and logs the urls and fingerprint', async () => {
    await setPassword('admin', 'correct horse battery');
    const port = await freePort();
    started = await startRemote(deps(remote({ port })), log);
    expect(started).not.toBeNull();

    const certPath = path.join(home, 'tls', 'cert.pem');
    const cert = fs.readFileSync(certPath, 'utf8');
    const fingerprint = new (await import('node:crypto')).X509Certificate(cert).fingerprint256;
    expect(logs).toContain(`Remote access: https://localhost:${port}/`);
    expect(logs).toContain(`Remote access certificate: ${certPath} (SHA-256 ${fingerprint})`);
    expect(logs).toContain(TRUST_HINT);

    const res = await get(port, cert, '/auth/mode');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ mode: 'password', signedIn: false });

    // API routes still need a signed-in session.
    expect((await get(port, cert, '/api/sessions')).status).toBe(401);

    const close = vi.spyOn(started!.auth, 'close');
    await started!.app.close();
    started = null;
    expect(close).toHaveBeenCalled();

    // A second start reuses the certificate, so there is nothing new to trust.
    logs = [];
    const port2 = await freePort();
    started = await startRemote(deps(remote({ port: port2 })), log);
    expect(started).not.toBeNull();
    expect(logs).toContain(`Remote access: https://localhost:${port2}/`);
    expect(logs).toContain(`Remote access certificate: ${certPath} (SHA-256 ${fingerprint})`);
    expect(logs).not.toContain(TRUST_HINT);
  }, CERT_TIMEOUT_MS);
});

describe('remoteUrls', () => {
  const cfg = (port: number, hostnames: string[]) => ({ port, bindHost: '0.0.0.0', hostnames, sessionDays: 30 });

  it('lists one url per host name, with IPv6 in brackets', () => {
    expect(remoteUrls(cfg(4318, ['ws1.corp', '10.0.0.5', '::1']))).toEqual([
      'https://ws1.corp:4318/',
      'https://10.0.0.5:4318/',
      'https://[::1]:4318/',
    ]);
  });

  it('omits the port when it is 443', () => {
    expect(remoteUrls(cfg(443, ['ws1.corp']))).toEqual(['https://ws1.corp/']);
  });
});
