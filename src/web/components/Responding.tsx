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
        <strong>Main session is responding</strong>
        {/* Hidden from screen readers: inside the live region it would be announced every second. */}
        <span className="responding-elapsed" aria-hidden="true">
          for {formatElapsed(activity.since, now)}
        </span>
        {activity.prompt && <span className="responding-prompt">“{activity.prompt}”</span>}
        <div className="hint">
          {quietMs > QUIET_MS
            ? `No activity for ${Math.floor(quietMs / 60000)} min. It may be waiting for a permission prompt, or it was interrupted.`
            : 'The new reply will appear here when it is done.'}
          {unitOpen && ' To pass what you found in this reply to the main session, press Integrate conclusions before the new reply arrives.'}
        </div>
      </div>
    </div>
  );
}
