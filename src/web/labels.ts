import type { SessionSummary, ThreadStatus, UnitStatus } from '../shared/types.js';

export const THREAD_STATUS_LABELS: Record<ThreadStatus, string> = {
  draft: '草稿',
  answering: '回答中',
  awaiting: '已回答',
  resolved: '有結論',
  error: '錯誤',
  expired: '已過期',
};

export const UNIT_STATUS_LABELS: Record<UnitStatus, string> = {
  open: '審查中',
  submitted: '已送出',
  stale: '已過期',
};

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
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

/** "剛剛", "N 分鐘前", "N 小時前", "N 天前"; the date itself past 30 days; '' for an invalid time. */
export function formatRelative(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = Math.max(0, nowMs - t);
  if (diff < MINUTE) return '剛剛';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分鐘前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小時前`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} 天前`;
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
