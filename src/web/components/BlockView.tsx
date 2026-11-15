import { useRef, useState } from 'react';
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

export function BlockView({ block, sourceId, parentThreadId, mode = 'markdown', lang }: Props) {
  const { readOnly, actions, threadsAt, imageUrl } = useUnit();
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [composerQuote, setComposerQuote] = useState<string | null>(null);
  const [selectionAsk, setSelectionAsk] = useState<SelectionAsk | null>(null);
  const threads = threadsAt(sourceId, block.id);

  const onMouseUp = () => {
    if (readOnly) return;
    const sel = window.getSelection();
    const quote = sel && !sel.isCollapsed ? sel.toString().trim() : '';
    if (!sel || !quote || !bodyRef.current || !rootRef.current) {
      setSelectionAsk(null);
      return;
    }
    // Only offer a question when the whole selection lies inside this block.
    const range = sel.getRangeAt(0);
    if (!bodyRef.current.contains(range.startContainer) || !bodyRef.current.contains(range.endContainer)) {
      setSelectionAsk(null);
      return;
    }
    const rect = range.getBoundingClientRect();
    const host = rootRef.current.getBoundingClientRect();
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
    <div ref={rootRef} className={`block${threads.length ? ' has-threads' : ''}`} data-block-id={block.id}>
      <div ref={bodyRef} className="block-body" onMouseUp={onMouseUp}>
        {mode === 'code' ? (
          <CodeBlock code={block.text} lang={lang} startLine={block.startLine} />
        ) : (
          <Markdown content={block.text} imageUrl={imageUrl} />
        )}
      </div>
      {!readOnly && (
        <button type="button" className="ask-btn" title="針對這個段落提問" onClick={() => openComposer(block.text)}>
          提問
        </button>
      )}
      {!readOnly && selectionAsk && (
        <button
          type="button"
          className="ask-selection"
          style={{ top: selectionAsk.top, left: selectionAsk.left }}
          // Keep the text selection alive while clicking.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => openComposer(selectionAsk.quote)}
        >
          提問
        </button>
      )}
      {composerQuote !== null && (
        <Composer
          quote={composerQuote === block.text ? undefined : composerQuote}
          placeholder={parentThreadId ? '針對這段回答提出子問題…' : '針對這段提出問題…'}
          submitLabel="加入草稿"
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
