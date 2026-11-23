import { useEffect, useState } from 'react';
import type { Thread } from '../../shared/types.js';
import { THREAD_STATUS_LABELS, firstLine } from '../labels.js';
import { fire, useReveal, useUnit } from '../unit-context.js';
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

  // A notification for this thread (or one under it) was clicked: unfold so it can be shown.
  const reveal = useReveal();
  const revealSeq = reveal?.threadIds.has(thread.id) ? reveal.seq : null;
  useEffect(() => {
    if (revealSeq !== null) setOpen(true);
  }, [revealSeq]);

  return (
    <section className={`thread status-${status}`} aria-label="Thread" data-thread-id={thread.id}>
      <header className="thread-head">
        <button type="button" className="thread-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span className="sr-only">{open ? 'Collapse' : 'Expand'}</span>
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
                <span className="you-label">You</span>
                <div className="msg-user-text">{m.content}</div>
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
          {status === 'answering' && <div className="thread-busy">Answering…</div>}
          {status === 'error' && <div className="thread-error">Failed: {thread.error ?? 'unknown error'}</div>}
          {status === 'resolved' && (
            <div className="thread-conclusion">
              <span className="label">Conclusion</span>
              {thread.noConclusion || thread.conclusion === null ? '(no conclusion)' : thread.conclusion}
            </div>
          )}
          {!readOnly && (
            <div className="thread-actions">
              {status === 'draft' && (
                <>
                  <button type="button" className="btn primary" onClick={() => fire(actions.sendThread(thread.id))}>
                    Send
                  </button>
                  <button type="button" className="btn ghost" onClick={() => fire(actions.deleteThread(thread.id))}>
                    Delete
                  </button>
                </>
              )}
              {status === 'error' && (
                <button type="button" className="btn" onClick={() => fire(actions.retry(thread.id))}>
                  Retry
                </button>
              )}
              {(status === 'awaiting' || status === 'resolved') && !composing && (
                <button type="button" className="btn" onClick={() => setComposing(true)}>
                  Follow up
                </button>
              )}
            </div>
          )}
          {!readOnly && composing && (
            <Composer
              placeholder="Follow up in this thread…"
              submitLabel="Send"
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
