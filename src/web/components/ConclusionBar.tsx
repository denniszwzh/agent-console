import { useState } from 'react';
import { carriedByAncestor, integrationState } from '../../shared/gate.js';
import type { ReviewUnit, Thread } from '../../shared/types.js';
import { firstLine } from '../labels.js';
import { fire, useUnit } from '../unit-context.js';

/** One concluded thread in the read-only list shown after the conclusions were handed back. */
function ConclusionItem({ thread }: { thread: Thread }) {
  const question = thread.messages.find((m) => m.role === 'user')?.content ?? '';
  const text = thread.noConclusion || thread.conclusion === null ? null : thread.conclusion;
  return (
    <li className="conclusion-item">
      <div className="conclusion-question">
        <span>{firstLine(question, 90)}</span>
      </div>
      <div className="conclusion-text">
        <span className={text === null ? 'muted' : undefined}>{text ?? '（無結論）'}</span>
      </div>
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

/** The single action of a turn under review: conclude every answered thread and hand them back. */
export function ConclusionBar() {
  const { unit, actions } = useUnit();
  const [expanded, setExpanded] = useState(false);
  const state = integrationState(unit);
  const integrating = unit.integrating === true;
  const submitted = unit.status === 'submitted';
  // Children are folded into their nearest concluded ancestor, as in the bundle.
  const concluded = unit.threads.filter((t) => t.status === 'resolved' && !carriedByAncestor(unit.threads, t));

  let reason = '';
  if (!submitted && !integrating) {
    if (state.answering > 0) reason = `還有 ${state.answering} 串正在回答`;
    else if (state.answered === 0) reason = '還沒有已回答的問題串';
  }

  return (
    <footer className="conclusion-bar">
      {submitted && expanded && (
        <ol className="conclusion-list">
          {concluded.length === 0 && <li className="muted">沒有結論。</li>}
          {concluded.map((t) => (
            <ConclusionItem key={t.id} thread={t} />
          ))}
        </ol>
      )}
      <div className="bar-row">
        {submitted ? (
          <button type="button" className="btn ghost" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {expanded ? '▾' : '▸'} 查看結論（{concluded.length}）
          </button>
        ) : integrating ? (
          <span className="bar-status" role="status">
            正在整合結論…（{state.concluded}/{state.total}）
          </span>
        ) : (
          <span className="bar-status muted">{state.answered > 0 ? `${state.answered} 串已回答` : ''}</span>
        )}
        <span className="spacer" />
        {reason && <span className="bar-reason muted">{reason}</span>}
        {!submitted && (
          <button
            type="button"
            className="btn primary"
            disabled={!state.canIntegrate}
            title="為每個已回答的問題串整理一行結論，並在下一則訊息帶入主對話"
            onClick={() => fire(actions.integrate())}
          >
            {integrating ? '整合中…' : '整合結論'}
          </button>
        )}
      </div>
      {!submitted && !integrating && unit.integrationError && (
        <div className="delivery error" role="alert">
          整合沒有完成：{unit.integrationError}。可以再按一次「整合結論」，已整理好的結論會保留。
        </div>
      )}
      {submitted && <DeliveryNotice unit={unit} />}
    </footer>
  );
}
