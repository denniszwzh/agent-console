import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../paths.js';
import { writeFileAtomic } from './fs-atomic.js';

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

const HEX = /^(?:[0-9a-f]{2})+$/;

function isAuthFile(v: unknown): v is AuthFile {
  if (!v || typeof v !== 'object') return false;
  const a = v as Record<string, unknown>;
  const s = a.scrypt as Record<string, unknown> | null;
  const intIn = (x: unknown, min: number, max: number): x is number =>
    Number.isInteger(x) && (x as number) >= min && (x as number) <= max;
  if (
    typeof a.username !== 'string' ||
    typeof a.salt !== 'string' || !HEX.test(a.salt) ||
    typeof a.hash !== 'string' || !HEX.test(a.hash) ||
    !s || typeof s !== 'object' ||
    !intIn(s.N, 2, 2 ** 20) || ((s.N as number) & ((s.N as number) - 1)) !== 0 ||
    !intIn(s.r, 1, 32) || !intIn(s.p, 1, 16) || !intIn(s.keylen, 16, 128) ||
    !intIn(a.sessionEpoch, 1, Number.MAX_SAFE_INTEGER)
  ) {
    return false;
  }
  return a.hash.length === (s.keylen as number) * 2;
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
  writeFileAtomic(authFilePath(), JSON.stringify(auth, null, 2));
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

// Epoch is also lower-bounded by the clock so that a deleted or corrupted auth file
// cannot make a new password reuse an epoch that old sessions were minted under.
function nextEpoch(prev: AuthFile | null): number {
  return Math.max((prev?.sessionEpoch ?? 0) + 1, Date.now());
}

export async function setPassword(username: string, password: string): Promise<AuthFile> {
  if ([...password.normalize('NFKC')].length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await derive(password, salt, SCRYPT);
  const auth: AuthFile = {
    username,
    salt: salt.toString('hex'),
    hash: key.toString('hex'),
    scrypt: { ...SCRYPT },
    sessionEpoch: nextEpoch(readAuthFile()),
  };
  writeAuthFile(auth);
  return auth;
}

/** Invalidate every existing session without touching the password. */
export function bumpEpoch(): AuthFile | null {
  const auth = readAuthFile();
  if (!auth) return null;
  const next = { ...auth, sessionEpoch: nextEpoch(auth) };
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
  let key: Buffer;
  try {
    key = await derive(password, salt, params);
  } catch {
    return false;
  }
  const expected = real ? Buffer.from(auth.hash, 'hex') : key;
  const hashOk = expected.length === key.length && crypto.timingSafeEqual(expected, key);
  const userOk = safeEqualStrings(real ? auth.username : '', username);
  return real && hashOk && userOk;
}
