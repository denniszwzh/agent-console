import { useState } from 'react';
import type { Thread } from '../../shared/types.js';
import { THREAD_STATUS_LABELS, firstLine } from '../labels.js';
import { fire, useUnit } from '../unit-context.js';
import { BlockView } from './BlockView.js';
import { Composer } from './Composer.js';
import { Markdown } from './Markdown.js';

interface Props {
  thread: Thread;
  /** Text of the block the thread hangs from; the quote is only repeated when it differs. */
  blockText?: string;
}

export function StatusPill({ status }: { status: Thread['status'] }) {
  return <span className={`status-pill status-${status}`}>{THREAD_STATUS_LABELS[status]}</span>;
}

export function ThreadView({ thread, blockText }: Props) {
  const { readOnly, actions, imageUrl } = useUnit();
  // History (earlier turns, submitted conclusions) starts folded; the turn under review starts open.
  const [open, setOpen] = useState(!readOnly && thread.status !== 'resolved' && thread.status !== 'expired');
  const [composing, setComposing] = useState(false);
  const question = thread.messages.find((m) => m.role === 'user')?.content ?? '';
  const { status } = thread;

  return (
    <section className={`thread status-${status}`} aria-label="問題串">
      <header className="thread-head">
        <button type="button" className="thread-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span className="sr-only">{open ? '收合' : '展開'}</span>
        </button>
        <StatusPill status={status} />
        {!open && <span className="thread-summary">{firstLine(question, 80)}</span>}
      </header>
      {open && (
        <div className="thread-body">
          {thread.anchor.quote !== blockText && <blockquote className="thread-quote">{thread.anchor.quote}</blockquote>}
          {thread.messages.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="msg msg-user">
                {m.content}
              </div>
            ) : (
              <div key={m.id} className="msg msg-assistant">
                {m.blocks?.length ? (
                  m.blocks.map((b) => <BlockView key={b.id} block={b} sourceId={`msg:${m.id}`} parentThreadId={thread.id} />)
                ) : (
                  <Markdown content={m.content} imageUrl={(p) => imageUrl(`msg:${m.id}`, p)} />
                )}
              </div>
            ),
          )}
          {status === 'answering' && <div className="thread-busy">回答中…</div>}
          {status === 'error' && <div className="thread-error">執行失敗：{thread.error ?? '未知錯誤'}</div>}
          {status === 'resolved' && (
            <div className="thread-conclusion">
              <span className="label">結論</span>
              {thread.noConclusion || thread.conclusion === null ? '（無結論）' : thread.conclusion}
            </div>
          )}
          {!readOnly && (
            <div className="thread-actions">
              {status === 'draft' && (
                <>
                  <button type="button" className="btn primary" onClick={() => fire(actions.sendThread(thread.id))}>
                    送出
                  </button>
                  <button type="button" className="btn ghost" onClick={() => fire(actions.deleteThread(thread.id))}>
                    刪除
                  </button>
                </>
              )}
              {status === 'error' && (
                <button type="button" className="btn" onClick={() => fire(actions.retry(thread.id))}>
                  重試
                </button>
              )}
              {(status === 'awaiting' || status === 'resolved') && !composing && (
                <button type="button" className="btn" onClick={() => setComposing(true)}>
                  追問
                </button>
              )}
            </div>
          )}
          {!readOnly && composing && (
            <Composer
              placeholder="在這個問題串裡追問…"
              submitLabel="送出"
              onSubmit={async (text) => {
                await actions.followUp(thread.id, text);
                setComposing(false);
              }}
              onCancel={() => setComposing(false)}
            />
          )}
        </div>
      )}
    </section>
  );
}
