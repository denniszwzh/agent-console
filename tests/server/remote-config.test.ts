import { describe, expect, it } from 'vitest';
import { allowedHosts, allowedOrigins, resolveRemoteConfig } from '../../src/server/remote/config.js';
import type { RemoteConfig } from '../../src/server/remote/config.js';

function ok(raw: unknown): RemoteConfig {
  const r = resolveRemoteConfig(raw);
  if (r.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r.config;
}

function invalidReason(raw: unknown): string {
  const r = resolveRemoteConfig(raw);
  if (r.status !== 'invalid') throw new Error(`expected invalid, got ${JSON.stringify(r)}`);
  return r.reason;
}

describe('resolveRemoteConfig', () => {
  it('returns disabled when remote is missing or enabled is not true', () => {
    for (const raw of [undefined, null, true, [], {}, { enabled: false }, { enabled: 'yes' }]) {
      expect(resolveRemoteConfig(raw)).toEqual({ status: 'disabled' });
    }
  });

  it('applies defaults', () => {
    expect(ok({ enabled: true, hostnames: ['ws1.corp'] })).toEqual({
      port: 4318,
      bindHost: '0.0.0.0',
      hostnames: ['ws1.corp'],
      sessionDays: 30,
    });
  });

  it('rejects empty hostnames', () => {
    expect(invalidReason({ enabled: true })).toContain('hostnames');
    expect(invalidReason({ enabled: true, hostnames: [] })).toContain('hostnames');
    expect(invalidReason({ enabled: true, hostnames: [''] })).toContain('hostnames');
    expect(invalidReason({ enabled: true, hostnames: [42] })).toContain('hostnames');
  });

  it('rejects certFile without keyFile and vice versa', () => {
    const base = { enabled: true, hostnames: ['ws1.corp'] };
    const a = invalidReason({ ...base, certFile: 'c.pem' });
    expect(a).toContain('certFile');
    expect(a).toContain('keyFile');
    const b = invalidReason({ ...base, keyFile: 'k.pem' });
    expect(b).toContain('certFile');
    expect(b).toContain('keyFile');
    expect(ok({ ...base, certFile: 'c.pem', keyFile: 'k.pem' })).toMatchObject({
      certFile: 'c.pem',
      keyFile: 'k.pem',
    });
  });

  it('rejects a non-integer or out-of-range port', () => {
    const base = { enabled: true, hostnames: ['ws1.corp'] };
    for (const port of [0, 70000, '4318', 1.5]) {
      expect(invalidReason({ ...base, port })).toContain('port');
    }
    expect(ok({ ...base, port: 8443 }).port).toBe(8443);
  });

  it('rejects sessionDays <= 0', () => {
    const base = { enabled: true, hostnames: ['ws1.corp'] };
    for (const sessionDays of [0, -1, 0.5, '30']) {
      expect(invalidReason({ ...base, sessionDays })).toContain('sessionDays');
    }
    expect(ok({ ...base, sessionDays: 7 }).sessionDays).toBe(7);
  });

  it('lowercases hostnames', () => {
    expect(ok({ enabled: true, hostnames: ['WS123.Corp.Example'] }).hostnames).toEqual([
      'ws123.corp.example',
    ]);
  });
});

describe('resolveRemoteConfig tightened validation', () => {
  const base = { enabled: true, hostnames: ['ws1.corp'] };

  it('rejects an empty or blank bindHost and trims a valid one', () => {
    expect(invalidReason({ ...base, bindHost: '' })).toContain('bindHost');
    expect(invalidReason({ ...base, bindHost: '   ' })).toContain('bindHost');
    expect(ok({ ...base, bindHost: ' 127.0.0.1 ' }).bindHost).toBe('127.0.0.1');
  });

  it('trims hostnames, certFile and keyFile', () => {
    expect(ok({ enabled: true, hostnames: ['  ws1.corp '] }).hostnames).toEqual(['ws1.corp']);
    expect(ok({ ...base, certFile: ' c.pem ', keyFile: ' k.pem ' })).toMatchObject({
      certFile: 'c.pem',
      keyFile: 'k.pem',
    });
    expect(invalidReason({ ...base, certFile: '  ', keyFile: 'k.pem' })).toContain('certFile');
  });

  it('rejects hostnames with a port, scheme or path', () => {
    for (const bad of ['ws1.corp:4318', 'https://ws1.corp', 'ws1.corp/x']) {
      const reason = invalidReason({ enabled: true, hostnames: [bad] });
      expect(reason).toContain('remote.hostnames');
      expect(reason).toContain(bad);
    }
  });

  it('canonicalises IPv6 hostnames', () => {
    expect(ok({ enabled: true, hostnames: ['0:0:0:0:0:0:0:1'] }).hostnames).toEqual(['::1']);
    expect(ok({ enabled: true, hostnames: ['::1'] }).hostnames).toEqual(['::1']);
  });
});

describe('allowedHosts / allowedOrigins', () => {
  const make = (port: number, hostnames = ['ws1.corp']): RemoteConfig => ({
    port,
    bindHost: '0.0.0.0',
    hostnames,
    sessionDays: 30,
  });

  it('includes only host:port for a non-443 port', () => {
    expect(allowedHosts(make(4318))).toEqual(new Set(['ws1.corp:4318']));
    expect(allowedOrigins(make(4318))).toEqual(new Set(['https://ws1.corp:4318']));
  });

  it('also accepts the bare host when the port is 443', () => {
    expect(allowedHosts(make(443))).toEqual(new Set(['ws1.corp:443', 'ws1.corp']));
    expect(allowedOrigins(make(443))).toEqual(
      new Set(['https://ws1.corp:443', 'https://ws1.corp']),
    );
  });

  it('brackets IPv6 hostnames', () => {
    expect(allowedHosts(make(4318, ['::1']))).toEqual(new Set(['[::1]:4318']));
    expect(allowedOrigins(make(4318, ['::1']))).toEqual(new Set(['https://[::1]:4318']));
    expect(allowedHosts(make(443, ['::1']))).toEqual(new Set(['[::1]:443', '[::1]']));
  });
});
