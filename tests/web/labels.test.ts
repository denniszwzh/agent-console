import { describe, expect, it } from 'vitest';
import { formatRelative, formatTime, sessionTitle } from '../../src/web/labels.js';
import type { SessionSummary } from '../../src/shared/types.js';

const T0 = Date.parse('2026-11-16T10:00:00.000Z');
const ago = (ms: number) => new Date(T0 - ms).toISOString();

describe('formatRelative', () => {
  it('says how long ago, in the largest whole unit', () => {
    expect(formatRelative(ago(30_000), T0)).toBe('just now');
    expect(formatRelative(ago(5 * 60_000), T0)).toBe('5 min ago');
    expect(formatRelative(ago(3 * 3600_000), T0)).toBe('3 h ago');
    expect(formatRelative(ago(2 * 86400_000), T0)).toBe('2 d ago');
  });

  it('falls back to the date after 30 days', () => {
    expect(formatRelative(ago(40 * 86400_000), T0)).toBe(formatTime(ago(40 * 86400_000)));
  });

  it('treats future times as now and invalid ones as empty', () => {
    expect(formatRelative(ago(-10_000), T0)).toBe('just now');
    expect(formatRelative('bad', T0)).toBe('');
  });
});

describe('sessionTitle', () => {
  const s: SessionSummary = { sessionId: 's1', agent: 'claude', cwd: 'C:\\p\\stock', lastActivity: ago(0) };
  it('uses the title, else the folder name', () => {
    expect(sessionTitle({ ...s, title: 'K棒反向交易功能' })).toBe('K棒反向交易功能');
    expect(sessionTitle(s)).toBe('stock');
  });
});
