import type { ThreadStatus, UnitStatus } from '../shared/types.js';

export const THREAD_STATUS_LABELS: Record<ThreadStatus, string> = {
  draft: '草稿',
  answering: '回答中',
  awaiting: '等待追問',
  resolved: '已結束',
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
