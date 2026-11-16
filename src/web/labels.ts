import type { SessionSummary, ThreadStatus, UnitStatus } from '../shared/types.js';

export const THREAD_STATUS_LABELS: Record<ThreadStatus, string> = {
  draft: 'Draft',
  answering: 'Answering',
  awaiting: 'Answered',
  resolved: 'Concluded',
  error: 'Error',
  expired: 'Expired',
};

export const UNIT_STATUS_LABELS: Record<UnitStatus, string> = {
  open: 'In review',
  submitted: 'Sent',
  stale: 'Expired',
};

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

export function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** First non-empty line of a text, stripped of Markdown heading/list markers. */
export function firstLine(text: string, max = 60): string {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
  const clean = line.replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, '').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "N min ago", "N h ago", "N d ago"; the date itself past 30 days; '' for an invalid time. */
export function formatRelative(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = Math.max(0, nowMs - t);
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h ago`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} d ago`;
  return formatTime(iso);
}

/** The session's name, or its folder name when the agent gave it none. */
export function sessionTitle(s: SessionSummary): string {
  return s.title ?? basename(s.cwd);
}

/** Last time anything happened in the session (transcript change, else latest reply). */
export function lastChanged(s: SessionSummary): string {
  return s.lastModified ?? s.lastActivity;
}
