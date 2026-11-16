import { useEffect, useState } from 'react';
import type { SessionActivity } from '../../shared/types.js';

/** After this long without transcript growth the banner says the turn may have stopped. */
const QUIET_MS = 3 * 60 * 1000;

/** Current time, re-read every `intervalMs`. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** "m:ss" (or "h:mm:ss") between an ISO time and now; never negative. */
export function formatElapsed(fromIso: string, nowMs: number): string {
  const total = Math.max(0, Math.floor((nowMs - Date.parse(fromIso)) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

interface Props {
  activity: SessionActivity;
  /** The unit on screen is still open: its open threads expire when the new reply arrives. */
  unitOpen?: boolean;
}

export function RespondingBanner({ activity, unitOpen }: Props) {
  const now = useNow();
  const quietMs = now - Date.parse(activity.lastChange);
  return (
    <div className="banner banner-responding" role="status" aria-live="polite">
      <span className="responding-dot" aria-hidden="true" />
      <div className="responding-text">
        <strong>主對話正在回應</strong>
        {/* Hidden from screen readers: inside the live region it would be announced every second. */}
        <span className="responding-elapsed" aria-hidden="true">
          已 {formatElapsed(activity.since, now)}
        </span>
        {activity.prompt && <span className="responding-prompt">「{activity.prompt}」</span>}
        <div className="hint">
          {quietMs > QUIET_MS
            ? `已經 ${Math.floor(quietMs / 60000)} 分鐘沒有新動靜，可能在等你確認權限，或已被中斷。`
            : '完成後新的回覆會自動出現在這裡。'}
          {unitOpen && ' 這則回覆中還沒結束的問題串，屆時會標示為過期。'}
        </div>
      </div>
    </div>
  );
}
