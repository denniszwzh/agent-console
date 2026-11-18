import crypto from 'node:crypto';
import fs from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { dataDir } from '../paths.js';
import { writeFileAtomic } from './fs-atomic.js';
import { canonicalHost, type RemoteConfig } from './config.js';

export interface TlsMaterial {
  cert: string;
  key: string;
  fingerprint256: string;
  source: 'configured' | 'self-signed';
  regenerated: boolean;
  certPath: string;
}

const VALID_YEARS = 2;
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Host names and IPs listed in the certificate's subjectAltName, canonicalised. */
function sanHosts(x509: crypto.X509Certificate): Set<string> {
  const out = new Set<string>();
  for (const part of (x509.subjectAltName ?? '').split(',')) {
    const m = /^\s*(DNS|IP Address):(.*)$/.exec(part);
    if (m) out.add(canonicalHost(m[2]!.replace(/^"(.*)"$/, '$1')));
  }
  return out;
}

function loadConfigured(certFile: string, keyFile: string): TlsMaterial {
  let cert: string;
  let key: string;
  try {
    cert = fs.readFileSync(certFile, 'utf8');
  } catch (e) {
    throw new Error(`Cannot read remote.certFile ${certFile}: ${describe(e)}`);
  }
  try {
    key = fs.readFileSync(keyFile, 'utf8');
  } catch (e) {
    throw new Error(`Cannot read remote.keyFile ${keyFile}: ${describe(e)}`);
  }
  let x509: crypto.X509Certificate;
  try {
    x509 = new crypto.X509Certificate(cert);
  } catch (e) {
    throw new Error(`remote.certFile ${certFile} is not a valid PEM certificate: ${describe(e)}`);
  }
  let privateKey: crypto.KeyObject;
  try {
    privateKey = crypto.createPrivateKey(key);
  } catch (e) {
    throw new Error(`remote.keyFile ${keyFile} is not a valid PEM private key: ${describe(e)}`);
  }
  if (!x509.checkPrivateKey(privateKey)) {
    throw new Error(`remote.keyFile ${keyFile} does not match remote.certFile ${certFile}`);
  }
  return { cert, key, fingerprint256: x509.fingerprint256, source: 'configured', regenerated: false, certPath: certFile };
}

/** Returns the existing self-signed pair when it is still usable, otherwise null. */
function reuseExisting(certPath: string, keyPath: string, hostnames: string[], now: Date): TlsMaterial | null {
  try {
    const cert = fs.readFileSync(certPath, 'utf8');
    const key = fs.readFileSync(keyPath, 'utf8');
    const x509 = new crypto.X509Certificate(cert);
    if (!x509.checkPrivateKey(crypto.createPrivateKey(key))) return null;
    if (new Date(x509.validTo).getTime() - now.getTime() <= RENEW_BEFORE_MS) return null;
    if (new Date(x509.validFrom).getTime() > now.getTime()) return null;
    const have = sanHosts(x509);
    const want = new Set(hostnames.map(canonicalHost));
    if (have.size !== want.size || [...want].some((h) => !have.has(h))) return null;
    return { cert, key, fingerprint256: x509.fingerprint256, source: 'self-signed', regenerated: false, certPath };
  } catch {
    return null;
  }
}

async function createSelfSigned(hostnames: string[], now: Date, certPath: string, keyPath: string): Promise<TlsMaterial> {
  const notAfter = new Date(now);
  notAfter.setFullYear(notAfter.getFullYear() + VALID_YEARS);
  // Loaded lazily so local-only startup and the reuse path never import it.
  const { default: selfsigned } = await import('selfsigned');
  const pems = await selfsigned.generate([{ name: 'commonName', value: hostnames[0]! }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notBeforeDate: now,
    notAfterDate: notAfter,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: hostnames.map((h) => (isIP(h) ? { type: 7, ip: h } : { type: 2, value: h })),
      },
    ],
  });
  fs.mkdirSync(path.dirname(certPath), { recursive: true });
  writeFileAtomic(keyPath, pems.private);
  writeFileAtomic(certPath, pems.cert);
  const x509 = new crypto.X509Certificate(pems.cert);
  return { cert: pems.cert, key: pems.private, fingerprint256: x509.fingerprint256, source: 'self-signed', regenerated: true, certPath };
}

/** Loads certFile/keyFile, or reuses / creates a self-signed pair in `dir` (default <dataDir>/tls). Throws with a readable message on bad files. */
export async function loadOrCreateCert(
  c: RemoteConfig,
  opts: { dir?: string; now?: () => Date } = {},
): Promise<TlsMaterial> {
  if (c.certFile && c.keyFile) return loadConfigured(c.certFile, c.keyFile);
  const dir = opts.dir ?? path.join(dataDir(), 'tls');
  const now = (opts.now ?? (() => new Date()))();
  const certPath = path.join(dir, 'cert.pem');
  const keyPath = path.join(dir, 'key.pem');
  return reuseExisting(certPath, keyPath, c.hostnames, now) ?? (await createSelfSigned(c.hostnames, now, certPath, keyPath));
}
