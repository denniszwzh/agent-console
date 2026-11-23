import type { Completion } from '../notifications.js';
import { formatRelative } from '../labels.js';
import { useNow } from './Responding.js';

/** Cards shown at once; older ones are counted in a "+N more" line. */
const MAX_SHOWN = 4;

interface Props {
  items: Completion[];
  /** Session name for a card's title. */
  titleOf(sessionId: string): string;
  onOpen(item: Completion): void;
  onDismiss(key: string): void;
  onClear(): void;
}

function label(item: Completion): string {
  if (item.kind === 'reply') return 'Reply finished';
  return item.failed ? 'Thread failed' : 'Thread answered';
}

/** Stacked "finished" cards in the corner; each one opens what finished and stays until clicked or closed. */
export function Notifications({ items, titleOf, onOpen, onDismiss, onClear }: Props) {
  const now = useNow(30_000);
  if (items.length === 0) return null;
  // Newest first, closest to the top of the stack.
  const shown = items.slice(-MAX_SHOWN).reverse();
  const hidden = items.length - shown.length;
  return (
    <div className="notifications" role="region" aria-label="Notifications" aria-live="polite">
      {items.length > 1 && (
        <div className="notifications-head">
          <span>
            {items.length} finished{hidden > 0 ? ` (${hidden} more not shown)` : ''}
          </span>
          <button type="button" className="btn ghost small" onClick={onClear}>
            Clear all
          </button>
        </div>
      )}
      {shown.map((item) => (
        <div key={item.key} className={`notification notification-${item.kind}${item.failed ? ' notification-failed' : ''}`}>
          <button type="button" className="notification-open" onClick={() => onOpen(item)} title="Go to it">
            <span className="notification-top">
              <span className="notification-label">{label(item)}</span>
              <span className="notification-time">{formatRelative(new Date(item.at).toISOString(), now)}</span>
            </span>
            <span className="notification-session">{titleOf(item.sessionId)}</span>
            {item.text && <span className="notification-text">{item.text}</span>}
          </button>
          <button type="button" className="notification-close" aria-label="Dismiss" title="Dismiss" onClick={() => onDismiss(item.key)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
