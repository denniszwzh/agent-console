import { useEffect, useRef, useState } from 'react';
import type { Anchor, Block } from '../../shared/types.js';
import { useUnit } from '../unit-context.js';
import { CodeBlock } from './CodeBlock.js';
import { Composer } from './Composer.js';
import { Markdown } from './Markdown.js';
import { ThreadView } from './ThreadView.js';

interface Props {
  block: Block;
  /** Reply or file source id, or 'msg:<messageId>' for a block of an answer. */
  sourceId: string;
  /** Set for blocks of an answer: questions asked here become child threads. */
  parentThreadId?: string;
  /** 'code' renders the block as a line-numbered code excerpt (non-Markdown files). */
  mode?: 'markdown' | 'code';
  lang?: string;
}

interface SelectionAsk {
  quote: string;
  top: number;
  left: number;
}

/** The current non-empty selection, if it lies entirely inside `container`. */
function selectedRangeIn(container: HTMLElement | null): Range | null {
  const sel = window.getSelection();
  if (!container || !sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  return container.contains(range.startContainer) && container.contains(range.endContainer) ? range : null;
}

/** Ordered list items are rendered one by one, so restore each item's number in its list. */
function withOrdinal(text: string, ordinal: number | undefined): string {
  return ordinal === undefined ? text : text.replace(/^(\s*)\d{1,9}([.)])/, `$1${ordinal}$2`);
}

export function BlockView({ block, sourceId, parentThreadId, mode = 'markdown', lang }: Props) {
  const { readOnly, actions, threadsAt, imageUrl } = useUnit();
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [composerQuote, setComposerQuote] = useState<string | null>(null);
  const [selectionAsk, setSelectionAsk] = useState<SelectionAsk | null>(null);
  const threads = threadsAt(sourceId, block.id);
  const showingSelectionAsk = selectionAsk !== null;

  // Drop the floating button once the selection collapses or moves out of this block.
  useEffect(() => {
    if (!showingSelectionAsk) return;
    const onChange = () => {
      if (!selectedRangeIn(bodyRef.current)) setSelectionAsk(null);
    };
    document.addEventListener('selectionchange', onChange);
    return () => document.removeEventListener('selectionchange', onChange);
  }, [showingSelectionAsk]);

  const onMouseUp = () => {
    if (readOnly) return;
    const range = selectedRangeIn(bodyRef.current);
    const quote = range ? range.toString().trim() : '';
    if (!range || !quote || !rootRef.current) {
      setSelectionAsk(null);
      return;
    }
    const host = rootRef.current.getBoundingClientRect();
    // getBoundingClientRect on ranges is missing in some environments (e.g. jsdom).
    const rect = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : host;
    setSelectionAsk({ quote, top: rect.bottom - host.top + 6, left: Math.max(0, rect.right - host.left - 24) });
  };

  const openComposer = (quote: string) => {
    setSelectionAsk(null);
    setComposerQuote(quote);
  };

  const ask = async (question: string) => {
    const anchor: Anchor = {
      sourceId,
      blockId: block.id,
      quote: composerQuote ?? block.text,
      headingPath: block.headingPath,
      startLine: block.startLine,
      endLine: block.endLine,
    };
    await actions.addThread(anchor, question, parentThreadId);
    setComposerQuote(null);
  };

  return (
    <div ref={rootRef} className={`block block-${block.kind}${threads.length ? ' has-threads' : ''}`} data-block-id={block.id}>
      <div ref={bodyRef} className="block-body" onMouseUp={onMouseUp}>
        {mode === 'code' ? (
          <CodeBlock code={block.text} lang={lang} startLine={block.startLine} />
        ) : (
          <Markdown content={withOrdinal(block.text, block.ordinal)} imageUrl={(p) => imageUrl(sourceId, p)} />
        )}
      </div>
      {!readOnly && (
        <button type="button" className="ask-btn" title="Ask about this paragraph" onClick={() => openComposer(block.text)}>
          Ask
        </button>
      )}
      {!readOnly && selectionAsk && (
        <button
          type="button"
          className="ask-selection"
          title="Ask about the selected text"
          style={{ top: selectionAsk.top, left: selectionAsk.left }}
          // Keep the text selection alive while clicking.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => openComposer(selectionAsk.quote)}
        >
          Ask
        </button>
      )}
      {composerQuote !== null && (
        <Composer
          quote={composerQuote === block.text ? undefined : composerQuote}
          placeholder={parentThreadId ? 'Ask about this part of the answer…' : 'Ask about this passage…'}
          submitLabel="Send"
          onSubmit={ask}
          onCancel={() => setComposerQuote(null)}
        />
      )}
      {threads.length > 0 && (
        <div className="block-threads">
          {threads.map((t) => (
            <ThreadView key={t.id} thread={t} blockText={block.text} />
          ))}
        </div>
      )}
    </div>
  );
}
