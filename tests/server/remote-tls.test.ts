import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RemoteConfig } from '../../src/server/remote/config.js';
import { loadOrCreateCert } from '../../src/server/remote/tls.js';

const cfg = (hostnames: string[], extra: Partial<RemoteConfig> = {}): RemoteConfig => ({
  port: 4318,
  bindHost: '0.0.0.0',
  hostnames,
  sessionDays: 30,
  ...extra,
});

describe('loadOrCreateCert', () => {
  let root: string;
  let n = 0;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-tls-'));
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
  /** A fresh, empty sub-directory per call so every test owns its state. */
  const sub = (): string => path.join(root, `t${n++}`);

  it('creates a self-signed cert whose SAN lists every hostname', async () => {
    const dir = sub();
    const t0 = new Date();
    const m = await loadOrCreateCert(cfg(['ws1.corp', '10.1.2.3']), { dir, now: () => t0 });
    const x = new crypto.X509Certificate(m.cert);
    expect(x.subjectAltName).toContain('DNS:ws1.corp');
    expect(x.subjectAltName).toContain('IP Address:10.1.2.3');
    expect(x.subject).toContain('CN=ws1.corp');
    const years = (new Date(x.validTo).getTime() - t0.getTime()) / (365 * 86400_000);
    expect(years).toBeGreaterThan(1.99);
    expect(years).toBeLessThan(2.02);
    expect(m.regenerated).toBe(true);
    expect(m.source).toBe('self-signed');
    expect(m.certPath).toBe(path.join(dir, 'cert.pem'));
    expect(fs.existsSync(path.join(dir, 'cert.pem'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'key.pem'))).toBe(true);
    expect(x.checkPrivateKey(crypto.createPrivateKey(m.key))).toBe(true);
  });

  it('reuses an existing cert when hostnames match (any order) and it is not near expiry', async () => {
    const dir = sub();
    const a = await loadOrCreateCert(cfg(['ws1.corp', '10.1.2.3']), { dir });
    const b = await loadOrCreateCert(cfg(['10.1.2.3', 'ws1.corp']), { dir });
    expect(a.regenerated).toBe(true);
    expect(b.regenerated).toBe(false);
    expect(b.fingerprint256).toBe(a.fingerprint256);
  });

  it('reuses an existing cert for an IPv6 hostname', async () => {
    const dir = sub();
    await loadOrCreateCert(cfg(['fe80::1']), { dir });
    expect((await loadOrCreateCert(cfg(['fe80::1']), { dir })).regenerated).toBe(false);
  });

  it('regenerates when hostnames change', async () => {
    const dir = sub();
    const before = await loadOrCreateCert(cfg(['ws1.corp', '10.1.2.3']), { dir });
    const after = await loadOrCreateCert(cfg(['ws2.corp', '10.1.2.3']), { dir });
    expect(after.regenerated).toBe(true);
    expect(after.fingerprint256).not.toBe(before.fingerprint256);
    expect(new crypto.X509Certificate(after.cert).subjectAltName).toContain('DNS:ws2.corp');
  });

  it('regenerates within 30 days of expiry', async () => {
    const dir = sub();
    const current = await loadOrCreateCert(cfg(['ws2.corp']), { dir });
    const expiry = new Date(new crypto.X509Certificate(current.cert).validTo);
    const near = new Date(expiry.getTime() - 29 * 86400_000);
    const m = await loadOrCreateCert(cfg(['ws2.corp']), { dir, now: () => near });
    expect(m.regenerated).toBe(true);
    expect(m.fingerprint256).not.toBe(current.fingerprint256);
  });

  it('regenerates when the existing cert is not yet valid', async () => {
    const dir = sub();
    const future = new Date(Date.now() + 10 * 86400_000);
    await loadOrCreateCert(cfg(['ws1.corp']), { dir, now: () => future });
    expect((await loadOrCreateCert(cfg(['ws1.corp']), { dir })).regenerated).toBe(true);
  });

  it('regenerates instead of throwing when the existing files are malformed', async () => {
    const dir = sub();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'cert.pem'), 'garbage');
    fs.writeFileSync(path.join(dir, 'key.pem'), 'garbage');
    const m = await loadOrCreateCert(cfg(['ws1.corp']), { dir });
    expect(m.regenerated).toBe(true);
  });

  /** Generates a pair in a fresh dir and copies it to configurable cert/key files. */
  async function configuredPair(): Promise<{ certFile: string; keyFile: string; fingerprint256: string }> {
    const dir = sub();
    const gen = await loadOrCreateCert(cfg(['ws2.corp']), { dir });
    const certFile = path.join(dir, 'my.crt');
    const keyFile = path.join(dir, 'my.key');
    fs.writeFileSync(certFile, gen.cert);
    fs.writeFileSync(keyFile, gen.key);
    return { certFile, keyFile, fingerprint256: gen.fingerprint256 };
  }

  it('loads a configured cert and key', async () => {
    const { certFile, keyFile, fingerprint256 } = await configuredPair();
    const unused = sub();
    const m = await loadOrCreateCert(cfg(['x.corp'], { certFile, keyFile }), { dir: unused });
    expect(m.source).toBe('configured');
    expect(m.regenerated).toBe(false);
    expect(m.certPath).toBe(certFile);
    expect(m.fingerprint256).toBe(fingerprint256);
    expect(fs.existsSync(unused)).toBe(false);
  });

  it('throws a readable error for a missing or malformed configured file, or a mismatched key', async () => {
    const { certFile, keyFile } = await configuredPair();
    const missing = path.join(root, 'nope.crt');
    await expect(loadOrCreateCert(cfg(['a'], { certFile: missing, keyFile }))).rejects.toThrow(missing);
    const missingKey = path.join(root, 'nope.key');
    await expect(loadOrCreateCert(cfg(['a'], { certFile, keyFile: missingKey }))).rejects.toThrow(missingKey);
    const bad = path.join(root, 'bad.crt');
    fs.writeFileSync(bad, 'not a cert');
    await expect(loadOrCreateCert(cfg(['a'], { certFile: bad, keyFile }))).rejects.toThrow(bad);
    const badKey = path.join(root, 'bad.key');
    fs.writeFileSync(badKey, 'not a key');
    await expect(loadOrCreateCert(cfg(['a'], { certFile, keyFile: badKey }))).rejects.toThrow(badKey);
    const other = await loadOrCreateCert(cfg(['other.corp']), { dir: sub() });
    const otherKey = path.join(root, 'other.key');
    fs.writeFileSync(otherKey, other.key);
    await expect(loadOrCreateCert(cfg(['a'], { certFile, keyFile: otherKey }))).rejects.toThrow(otherKey);
  });
});
