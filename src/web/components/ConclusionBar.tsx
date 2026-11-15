import { useState } from 'react';
import { canSubmit } from '../../shared/gate.js';
import type { ReviewUnit, Thread } from '../../shared/types.js';
import { firstLine } from '../labels.js';
import { fire, useUnit } from '../unit-context.js';
import { StatusPill } from './ThreadView.js';

function ConclusionItem({ thread }: { thread: Thread }) {
  const { readOnly, actions } = useUnit();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const question = thread.messages.find((m) => m.role === 'user')?.content ?? '';
  const resolved = thread.status === 'resolved';
  const text = thread.noConclusion || thread.conclusion === null ? null : thread.conclusion;

  const save = async () => {
    try {
      await actions.setConclusion(thread.id, draft.trim() ? draft.trim() : null);
      setEditing(false);
    } catch {
      // Already reported; stay in edit mode.
    }
  };

  return (
    <li className="conclusion-item">
      <div className="conclusion-question">
        {!resolved && <StatusPill status={thread.status} />}
        <span>{firstLine(question, 90)}</span>
      </div>
      {resolved &&
        (editing ? (
          <div className="conclusion-edit">
            <input
              autoFocus
              value={draft}
              placeholder="一行結論；留空代表無結論"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save();
                if (e.key === 'Escape') setEditing(false);
              }}
            />
            <button type="button" className="btn primary" onClick={() => void save()}>
              儲存
            </button>
            <button type="button" className="btn ghost" onClick={() => setEditing(false)}>
              取消
            </button>
          </div>
        ) : (
          <div className="conclusion-text">
            <span className={text === null ? 'muted' : undefined}>{text ?? '（無結論）'}</span>
            {!readOnly && (
              <span className="conclusion-tools">
                <button
                  type="button"
                  className="btn ghost small"
                  onClick={() => {
                    setDraft(text ?? '');
                    setEditing(true);
                  }}
                >
                  編輯
                </button>
                {text !== null && (
                  <button type="button" className="btn ghost small" onClick={() => fire(actions.setConclusion(thread.id, null))}>
                    標記為無結論
                  </button>
                )}
              </span>
            )}
          </div>
        ))}
    </li>
  );
}

/** What happens after submission depends on the agent. */
function DeliveryNotice({ unit }: { unit: ReviewUnit }) {
  if (unit.agent === 'claude') {
    return (
      <div className="delivery">
        {unit.delivered
          ? '結論已帶入主對話。'
          : '在 terminal 送出下一則訊息時（例如「套用審查結論」），結論會自動帶入主對話'}
      </div>
    );
  }
  // Task 12: the Codex copy button ("複製") is rendered here.
  return null;
}

export function ConclusionBar() {
  const { unit, readOnly, actions } = useUnit();
  const [expanded, setExpanded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const topLevel = unit.threads.filter((t) => t.parentThreadId === null);
  const resolvedCount = unit.threads.filter((t) => t.status === 'resolved').length;
  const drafts = unit.threads.filter((t) => t.status === 'draft').length;
  const submittable = canSubmit(unit);

  const submit = async () => {
    setSubmitting(true);
    try {
      await actions.submit();
    } catch {
      // Already reported.
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <footer className="conclusion-bar">
      {expanded && (
        <ol className="conclusion-list">
          {topLevel.length === 0 && <li className="muted">還沒有問題串。</li>}
          {topLevel.map((t) => (
            <ConclusionItem key={t.id} thread={t} />
          ))}
        </ol>
      )}
      <div className="bar-row">
        <button type="button" className="btn ghost" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? '▾' : '▸'} 結論預覽（{resolvedCount}/{unit.threads.length}）
        </button>
        <span className="spacer" />
        {!readOnly && (
          <button type="button" className="btn" disabled={drafts === 0} onClick={() => fire(actions.sendDrafts())}>
            送出全部草稿{drafts > 0 ? `（${drafts}）` : ''}
          </button>
        )}
        <button
          type="button"
          className="btn primary"
          disabled={!submittable || submitting}
          title={submittable ? '把結論打包送回主對話' : '所有問題串都結束後才能送出'}
          onClick={() => void submit()}
        >
          送出結論
        </button>
      </div>
      {unit.status === 'submitted' && <DeliveryNotice unit={unit} />}
    </footer>
  );
}
