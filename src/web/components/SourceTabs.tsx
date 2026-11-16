import { useState, type FormEvent, type ReactNode } from 'react';
import type { Source } from '../../shared/types.js';
import { basename } from '../labels.js';
import { isOpenThread, rootSourceId, useUnit } from '../unit-context.js';

interface Props {
  activeId: string;
  onSelect(sourceId: string): void;
  /** Called just before a file is added, so the view can switch to it once it arrives. */
  onAddingFile(): void;
  /** Rendered before the tabs (the "show sidebar" button when the sidebar is hidden). */
  leading?: ReactNode;
}

export function SourceTabs({ activeId, onSelect, onAddingFile, leading }: Props) {
  const { unit, readOnly, actions } = useUnit();
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const sources: Source[] = [unit.reply, ...unit.files];

  const openCount = (sourceId: string) =>
    unit.threads.filter((t) => isOpenThread(t) && rootSourceId(unit, t) === sourceId).length;

  const addFile = async (e: FormEvent) => {
    e.preventDefault();
    if (!path.trim() || busy) return;
    setBusy(true);
    onAddingFile();
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

  return (
    <nav className="tabs">
      {leading}
      <div role="tablist" aria-label="審查內容" className="tab-list">
        {sources.map((s) => {
          const n = openCount(s.id);
          return (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={s.id === activeId}
              className="tab"
              title={s.path ?? '回覆'}
              onClick={() => onSelect(s.id)}
            >
              <span className="tab-label">{s.kind === 'reply' ? '回覆' : basename(s.path ?? '檔案')}</span>
              {s.detectedBy === 'mtime' && (
                <span className="tab-guess" title="依修改時間找到，不一定是 agent 改的">
                  {' '}
                  可能
                </span>
              )}
              {n > 0 && (
                <span className="tab-count" title={`${n} 個未結束問題串`}>
                  {' '}
                  {n}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {!readOnly &&
        (adding ? (
          <form className="add-file" onSubmit={addFile}>
            <input
              autoFocus
              value={path}
              placeholder={`檔案路徑（相對於 ${unit.cwd}）`}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setAdding(false)}
            />
            <button type="submit" className="btn primary" disabled={!path.trim() || busy}>
              加入
            </button>
            <button type="button" className="btn ghost" onClick={() => setAdding(false)}>
              取消
            </button>
          </form>
        ) : (
          <button type="button" className="btn ghost add-file-btn" onClick={() => setAdding(true)}>
            ＋ 加入檔案
          </button>
        ))}
    </nav>
  );
}
