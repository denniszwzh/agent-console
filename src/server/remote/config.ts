import { isIP } from 'node:net';

export interface RemoteConfig {
  port: number;
  bindHost: string;
  hostnames: string[];
  certFile?: string;
  keyFile?: string;
  sessionDays: number;
}

export type RemoteConfigResult =
  | { status: 'disabled' }
  | { status: 'invalid'; reason: string }
  | { status: 'ok'; config: RemoteConfig };

const DEFAULT_PORT = 4318;
const DEFAULT_BIND_HOST = '0.0.0.0';
const DEFAULT_SESSION_DAYS = 30;

function invalid(reason: string): RemoteConfigResult {
  return { status: 'invalid', reason };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/** Validate the raw `remote` block of config.json. Never throws. */
export function resolveRemoteConfig(raw: unknown): RemoteConfigResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { status: 'disabled' };
  const r = raw as Record<string, unknown>;
  if (r.enabled !== true) return { status: 'disabled' };

  const port = r.port ?? DEFAULT_PORT;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    return invalid('remote.port must be an integer between 1 and 65535');
  }

  const sessionDays = r.sessionDays ?? DEFAULT_SESSION_DAYS;
  if (typeof sessionDays !== 'number' || !Number.isInteger(sessionDays) || sessionDays <= 0) {
    return invalid('remote.sessionDays must be a positive integer');
  }

  const rawBindHost = r.bindHost ?? DEFAULT_BIND_HOST;
  if (!isNonEmptyString(rawBindHost)) return invalid('remote.bindHost must be a non-empty string');
  const bindHost = rawBindHost.trim();

  if (
    !Array.isArray(r.hostnames) ||
    r.hostnames.length === 0 ||
    !r.hostnames.every(isNonEmptyString)
  ) {
    return invalid('remote.hostnames must be a non-empty array of host names');
  }
  const hostnames: string[] = [];
  for (const entry of r.hostnames as string[]) {
    const h = entry.trim().toLowerCase();
    const isV6 = isIP(h) === 6;
    if (h.includes('/') || (h.includes(':') && !isV6)) {
      return invalid(`remote.hostnames entry "${entry}" must be a bare host name or IP`);
    }
    hostnames.push(isV6 ? new URL(`http://[${h}]`).hostname.slice(1, -1) : h);
  }

  const hasCert = r.certFile !== undefined;
  const hasKey = r.keyFile !== undefined;
  if (hasCert !== hasKey) {
    return invalid('remote.certFile and remote.keyFile must be set together');
  }
  if (hasCert && (!isNonEmptyString(r.certFile) || !isNonEmptyString(r.keyFile))) {
    return invalid('remote.certFile and remote.keyFile must be non-empty strings');
  }

  const config: RemoteConfig = { port, bindHost, hostnames, sessionDays };
  if (hasCert) {
    config.certFile = (r.certFile as string).trim();
    config.keyFile = (r.keyFile as string).trim();
  }
  return { status: 'ok', config };
}

function hostForm(hostname: string): string {
  return isIP(hostname) === 6 ? `[${hostname}]` : hostname;
}

/** Host header values accepted for this config (port omitted too when port is 443). */
export function allowedHosts(c: RemoteConfig): Set<string> {
  const out = new Set<string>();
  for (const h of c.hostnames) {
    const host = hostForm(h);
    out.add(`${host}:${c.port}`);
    if (c.port === 443) out.add(host);
  }
  return out;
}

/** Origin header values accepted for this config (port omitted too when port is 443). */
export function allowedOrigins(c: RemoteConfig): Set<string> {
  return new Set([...allowedHosts(c)].map((h) => `https://${h}`));
}
