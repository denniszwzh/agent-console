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
  let dir: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-tls-'));
    dir = path.join(root, 'tls');
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('creates a self-signed cert whose SAN lists every hostname', async () => {
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
    const a = await loadOrCreateCert(cfg(['ws1.corp', '10.1.2.3']), { dir });
    const b = await loadOrCreateCert(cfg(['10.1.2.3', 'ws1.corp']), { dir });
    expect(a.regenerated).toBe(false);
    expect(b.regenerated).toBe(false);
    expect(b.fingerprint256).toBe(a.fingerprint256);
  });

  it('regenerates when hostnames change', async () => {
    const before = await loadOrCreateCert(cfg(['ws1.corp', '10.1.2.3']), { dir });
    const after = await loadOrCreateCert(cfg(['ws2.corp', '10.1.2.3']), { dir });
    expect(after.regenerated).toBe(true);
    expect(after.fingerprint256).not.toBe(before.fingerprint256);
    expect(new crypto.X509Certificate(after.cert).subjectAltName).toContain('DNS:ws2.corp');
  });

  it('regenerates within 30 days of expiry', async () => {
    const current = await loadOrCreateCert(cfg(['ws2.corp', '10.1.2.3']), { dir });
    const expiry = new Date(new crypto.X509Certificate(current.cert).validTo);
    const near = new Date(expiry.getTime() - 29 * 86400_000);
    const m = await loadOrCreateCert(cfg(['ws2.corp', '10.1.2.3']), { dir, now: () => near });
    expect(m.regenerated).toBe(true);
    expect(m.fingerprint256).not.toBe(current.fingerprint256);
  });

  it('regenerates instead of throwing when the existing files are malformed', async () => {
    const d = path.join(root, 'bad');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'cert.pem'), 'garbage');
    fs.writeFileSync(path.join(d, 'key.pem'), 'garbage');
    const m = await loadOrCreateCert(cfg(['ws1.corp']), { dir: d });
    expect(m.regenerated).toBe(true);
  });

  it('loads a configured cert and key', async () => {
    const gen = await loadOrCreateCert(cfg(['ws2.corp', '10.1.2.3']), { dir });
    const certFile = path.join(root, 'my.crt');
    const keyFile = path.join(root, 'my.key');
    fs.writeFileSync(certFile, gen.cert);
    fs.writeFileSync(keyFile, gen.key);
    const unused = path.join(root, 'unused');
    const m = await loadOrCreateCert(cfg(['x.corp'], { certFile, keyFile }), { dir: unused });
    expect(m.source).toBe('configured');
    expect(m.regenerated).toBe(false);
    expect(m.certPath).toBe(certFile);
    expect(m.fingerprint256).toBe(gen.fingerprint256);
    expect(fs.existsSync(unused)).toBe(false);
  });

  it('throws a readable error for a missing or malformed configured file, or a mismatched key', async () => {
    const gen = await loadOrCreateCert(cfg(['ws2.corp', '10.1.2.3']), { dir });
    const good = path.join(root, 'g.crt');
    const goodKey = path.join(root, 'g.key');
    fs.writeFileSync(good, gen.cert);
    fs.writeFileSync(goodKey, gen.key);
    const missing = path.join(root, 'nope.crt');
    await expect(loadOrCreateCert(cfg(['a'], { certFile: missing, keyFile: goodKey }))).rejects.toThrow(missing);
    const bad = path.join(root, 'bad.crt');
    fs.writeFileSync(bad, 'not a cert');
    await expect(loadOrCreateCert(cfg(['a'], { certFile: bad, keyFile: goodKey }))).rejects.toThrow(bad);
    const badKey = path.join(root, 'bad.key');
    fs.writeFileSync(badKey, 'not a key');
    await expect(loadOrCreateCert(cfg(['a'], { certFile: good, keyFile: badKey }))).rejects.toThrow(badKey);
    const other = await loadOrCreateCert(cfg(['other.corp']), { dir: path.join(root, 'other') });
    const otherKey = path.join(root, 'other.key');
    fs.writeFileSync(otherKey, other.key);
    await expect(loadOrCreateCert(cfg(['a'], { certFile: good, keyFile: otherKey }))).rejects.toThrow(otherKey);
  });
});
