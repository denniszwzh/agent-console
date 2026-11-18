import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../../src/server/remote/sessions.js';

const DAY = 86_400_000;
const META = { ip: '203.0.113.5', userAgent: 'vitest' };

describe('SessionStore', () => {
  let dir: string;
  let file: string;
  let t: number;
  const make = () => new SessionStore({ file, sessionDays: 30, now: () => t });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-sessions-'));
    file = path.join(dir, 'sessions.json');
    t = 1_000_000_000_000;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('create returns a 64-char hex id and persists only its sha256', () => {
    const { id, key } = make().create(1, META);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(key).toBe(crypto.createHash('sha256').update(id).digest('hex'));
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).not.toContain(id);
    expect(raw).toContain(key);
  });

  it('check accepts a fresh session and rejects unknown ids', () => {
    const s = make();
    const { id, key } = s.create(1, META);
    expect(s.check(id, 1)).toEqual({ valid: true, key, refresh: false });
    expect(s.check('0'.repeat(64), 1)).toEqual({ valid: false });
    expect(s.check('nope', 1)).toEqual({ valid: false });
  });

  it('check rejects a session whose epoch differs', () => {
    const s = make();
    const { id } = s.create(1, META);
    expect(s.check(id, 2)).toEqual({ valid: false });
  });

  it('check rejects an expired session and slides expiry on use', () => {
    const s = make();
    const a = s.create(1, META);
    const b = s.create(1, META);
    t += 29 * DAY;
    expect(s.check(a.id, 1).valid).toBe(true);
    t += 29 * DAY; // day 58
    expect(s.check(a.id, 1).valid).toBe(true);
    expect(s.check(b.id, 1).valid).toBe(false);
  });

  it('rejects a session once 30 days pass without use', () => {
    const s = make();
    const { id } = s.create(1, META);
    t += 30 * DAY;
    expect(s.check(id, 1).valid).toBe(false);
  });

  it('refresh is true only once per 24 hours', () => {
    const s = make();
    const { id } = s.create(1, META);
    t += DAY - 1000;
    expect(s.check(id, 1)).toMatchObject({ valid: true, refresh: false });
    t += 2000;
    expect(s.check(id, 1)).toMatchObject({ valid: true, refresh: true });
    t += 1000;
    expect(s.check(id, 1)).toMatchObject({ valid: true, refresh: false });
    t += DAY;
    expect(s.check(id, 1)).toMatchObject({ valid: true, refresh: true });
  });

  it('revoke makes the id invalid', () => {
    const s = make();
    const { id } = s.create(1, META);
    s.revoke(id);
    expect(s.check(id, 1)).toEqual({ valid: false });
    expect(make().check(id, 1)).toEqual({ valid: false });
  });

  it('a new store instance reads sessions written by an earlier one', () => {
    const { id, key } = make().create(1, META);
    t += DAY + 1;
    expect(make().check(id, 1)).toEqual({ valid: true, key, refresh: true });
  });

  it('expired sessions are dropped from the file on write', () => {
    const s = make();
    const old = s.create(1, META);
    t += 31 * DAY;
    const fresh = s.create(1, META);
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).not.toContain(old.key);
    expect(raw).toContain(fresh.key);
  });

  it('expired sessions are dropped when the file is loaded', () => {
    const old = make().create(1, META);
    t += 31 * DAY;
    const s = make(); // loads after the old session expired
    t -= 31 * DAY; // clock back below expiry: only load can have dropped it
    s.create(1, META);
    expect(fs.readFileSync(file, 'utf8')).not.toContain(old.key);
    expect(s.check(old.id, 1).valid).toBe(false);
  });

  it('a failed revoke restores the session so memory matches disk', () => {
    const s = make();
    const { id } = s.create(1, META);
    fs.rmSync(file);
    fs.mkdirSync(file); // rename onto a directory fails deterministically
    expect(() => s.revoke(id)).toThrow();
    expect(s.check(id, 1).valid).toBe(true);
  });

  it.each(['', '   ', '{not json', '[]', '{"sessions":"x"}', '{"sessions":[null,1,{"key":5}]}'])(
    'an empty or malformed sessions file counts as no sessions (%j)',
    (content) => {
      fs.writeFileSync(file, content);
      const s = make();
      expect(s.check('a'.repeat(64), 1)).toEqual({ valid: false });
      const { id } = s.create(1, META);
      expect(make().check(id, 1).valid).toBe(true);
    },
  );
});
