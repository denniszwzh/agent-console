import { useState, type FormEvent, type ReactNode } from 'react';
import { useUnit } from '../unit-context.js';

export interface TabSpec {
  id: string;
  label: string;
  title?: string;
  /** Unfinished threads on this tab's source. */
  count?: number;
  /** Found by modification time only: may not be the agent's change. */
  guess?: boolean;
  closable?: boolean;
  /** Accessible name of the close button (closable tabs). */
  closeLabel?: string;
}

interface Props {
  tabs: TabSpec[];
  activeId: string;
  onSelect(id: string): void;
  onClose?(id: string): void;
  /** Rendered before the tabs (the "show sidebar" button when the sidebar is hidden). */
  leading?: ReactNode;
  /** Rendered after the tabs (the add-file control). */
  trailing?: ReactNode;
}

export function SourceTabs({ tabs, activeId, onSelect, onClose, leading, trailing }: Props) {
  return (
    <nav className="tabs">
      {leading}
      <div role="tablist" aria-label="Review content" className="tab-list">
        {tabs.map((t) => (
          <span key={t.id} className={`tab-wrap${t.closable ? ' closable' : ''}`}>
            <button type="button" role="tab" aria-selected={t.id === activeId} className="tab" title={t.title} onClick={() => onSelect(t.id)}>
              <span className="tab-label">{t.label}</span>
              {t.guess && (
                <span className="tab-guess" title="Found by modification time; the agent may not have changed it">
                  {' '}
                  maybe
                </span>
              )}
              {t.count !== undefined && t.count > 0 && (
                <span className="tab-count" title={`${t.count} being answered`}>
                  {' '}
                  {t.count}
                </span>
              )}
            </button>
            {t.closable && onClose && (
              <button type="button" className="tab-close" aria-label={t.closeLabel ?? `Close ${t.label}`} onClick={() => onClose(t.id)}>
                ×
              </button>
            )}
          </span>
        ))}
      </div>
      {trailing}
    </nav>
  );
}

/** "+ Add file" for the unit in context; render it inside that unit's UnitProvider. */
export function AddFileButton({ onAdding }: { onAdding(): void }) {
  const { unit, readOnly, actions } = useUnit();
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  if (readOnly) return null;

  const addFile = async (e: FormEvent) => {
    e.preventDefault();
    if (!path.trim() || busy) return;
    setBusy(true);
    onAdding();
    try {
      await actions.addFile(path.trim());
      setPath('');
      setAdding(false);
    } catch {
      // Already reported; keep the path so it can be corrected.
    } finally {
      setBusy(false);
    }
  };

  return adding ? (
    <form className="add-file" onSubmit={addFile}>
      <input
        autoFocus
        value={path}
        placeholder={`File path (relative to ${unit.cwd})`}
        onChange={(e) => setPath(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && setAdding(false)}
      />
      <button type="submit" className="btn primary" disabled={!path.trim() || busy}>
        Add
      </button>
      <button type="button" className="btn ghost" onClick={() => setAdding(false)}>
        Cancel
      </button>
    </form>
  ) : (
    <button type="button" className="btn ghost add-file-btn" onClick={() => setAdding(true)}>
      + Add file
    </button>
  );
}
