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

/** A copy-to-clipboard button that confirms with 已複製. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button type="button" className="btn small" onClick={() => void copy()}>
      {copied ? '已複製' : '複製'}
    </button>
  );
}

/** What happens after submission depends on the agent. */
function DeliveryNotice({ unit }: { unit: ReviewUnit }) {
  if (unit.agent === 'claude') return <ClaudeDelivery unit={unit} />;
  return <CodexDelivery unit={unit} />;
}

/** Claude gets the bundle via the prompt hook; the file path is the fallback for /clear'ed or closed sessions. */
function ClaudeDelivery({ unit }: { unit: ReviewUnit }) {
  return (
    <div className="delivery">
      <span>
        {unit.delivered
          ? '結論已帶入主對話。'
          : '在 terminal 送出下一則訊息時（例如「套用審查結論」），結論會自動帶入主對話'}
      </span>
      {unit.conclusionsPath && (
        <>
          <span>若 session 已 /clear 或關閉，可複製結論檔路徑，請 Claude 讀取並套用：</span>
          <code>{unit.conclusionsPath}</code>
          <CopyButton text={unit.conclusionsPath} />
        </>
      )}
    </div>
  );
}

/** Codex has no prompt hook: the instruction is queued when possible and can always be copied. */
function CodexDelivery({ unit }: { unit: ReviewUnit }) {
  const instruction = unit.delivery?.instruction;
  // Submitted, but the queue attempt (up to ~10 s) has not reported back yet.
  if (!instruction) return <div className="delivery muted">正在送入 Codex 佇列…</div>;
  return (
    <div className="delivery">
      <span>{unit.delivery?.queued ? '已送入佇列；若下一輪沒有帶入，再複製下面的指令貼到 Codex。' : '貼到 Codex 對話即可套用結論：'}</span>
      <code>{instruction}</code>
      <CopyButton text={instruction} />
    </div>
  );
}

export function ConclusionBar() {
  const { unit, readOnly, actions } = useUnit();
  const [expanded, setExpanded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const topLevel = unit.threads.filter((t) => t.parentThreadId === null);
  // Child conclusions are folded into their parent, so the counter tracks the listed (top-level) threads.
  const resolvedCount = topLevel.filter((t) => t.status === 'resolved').length;
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
          {expanded ? '▾' : '▸'} 結論預覽（{resolvedCount}/{topLevel.length}）
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
          {submitting ? '送出中…' : '送出結論'}
        </button>
      </div>
      {submitting && (
        <div className="delivery muted" role="status">
          正在送出結論…
        </div>
      )}
      {unit.status === 'submitted' && <DeliveryNotice unit={unit} />}
    </footer>
  );
}
