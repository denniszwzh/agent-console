import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../paths.js';

export interface AuthFile {
  username: string;
  salt: string;
  hash: string;
  scrypt: { N: number; r: number; p: number; keylen: number };
  sessionEpoch: number;
}

export const MIN_PASSWORD_LENGTH = 12;

// N=2^15, r=8, p=1 needs ~32 MiB and takes roughly 100 ms on a laptop.
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64 };
const SALT_BYTES = 16;
// Fixed salt used for the "no such user" path so it still costs a full scrypt run.
const FAKE_SALT = Buffer.alloc(SALT_BYTES, 0xa5);

export function authFilePath(): string {
  return path.join(dataDir(), 'auth.json');
}

const HEX = /^[0-9a-f]+$/;

function isAuthFile(v: unknown): v is AuthFile {
  if (!v || typeof v !== 'object') return false;
  const a = v as Record<string, unknown>;
  const s = a.scrypt as Record<string, unknown> | null;
  const posInt = (x: unknown): x is number => Number.isInteger(x) && (x as number) > 0;
  return (
    typeof a.username === 'string' &&
    typeof a.salt === 'string' && HEX.test(a.salt) &&
    typeof a.hash === 'string' && HEX.test(a.hash) &&
    !!s && typeof s === 'object' &&
    posInt(s.N) && posInt(s.r) && posInt(s.p) && posInt(s.keylen) &&
    posInt(a.sessionEpoch)
  );
}

/** Missing, empty or malformed file -> null. */
export function readAuthFile(): AuthFile | null {
  try {
    const raw = JSON.parse(fs.readFileSync(authFilePath(), 'utf8'));
    return isAuthFile(raw) ? raw : null;
  } catch {
    return null;
  }
}

function writeAuthFile(auth: AuthFile): void {
  const file = authFilePath();
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    // Mode 0o600 has no effect on Windows.
    fs.writeFileSync(tmp, JSON.stringify(auth, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

function derive(
  password: string,
  salt: Buffer,
  p: { N: number; r: number; p: number; keylen: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password.normalize('NFKC'),
      salt,
      p.keylen,
      { N: p.N, r: p.r, p: p.p, maxmem: 128 * p.N * p.r * 2 },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

export async function setPassword(username: string, password: string): Promise<AuthFile> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await derive(password, salt, SCRYPT);
  const auth: AuthFile = {
    username,
    salt: salt.toString('hex'),
    hash: key.toString('hex'),
    scrypt: { ...SCRYPT },
    sessionEpoch: (readAuthFile()?.sessionEpoch ?? 0) + 1,
  };
  writeAuthFile(auth);
  return auth;
}

/** Invalidate every existing session without touching the password. */
export function bumpEpoch(): AuthFile | null {
  const auth = readAuthFile();
  if (!auth) return null;
  const next = { ...auth, sessionEpoch: auth.sessionEpoch + 1 };
  writeAuthFile(next);
  return next;
}

function safeEqualStrings(a: string, b: string): boolean {
  // Hash both sides so unequal lengths do not short-circuit.
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export async function verifyCredentials(
  auth: AuthFile | null,
  username: string,
  password: string,
): Promise<boolean> {
  const real = auth !== null;
  const salt = real ? Buffer.from(auth.salt, 'hex') : FAKE_SALT;
  const params = real ? auth.scrypt : SCRYPT;
  const key = await derive(password, salt, params);
  const expected = real ? Buffer.from(auth.hash, 'hex') : key;
  const hashOk = expected.length === key.length && crypto.timingSafeEqual(expected, key);
  const userOk = safeEqualStrings(real ? auth.username : '', username);
  return real && hashOk && userOk;
}
