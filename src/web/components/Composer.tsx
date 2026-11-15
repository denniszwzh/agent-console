import { useState, type FormEvent, type KeyboardEvent } from 'react';

interface Props {
  /** Quoted text the question is about, shown above the input. */
  quote?: string;
  placeholder: string;
  submitLabel: string;
  onSubmit(text: string): Promise<void>;
  onCancel(): void;
}

export function Composer({ quote, placeholder, submitLabel, onSubmit, onCancel }: Props) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await onSubmit(text.trim());
      setText('');
    } catch {
      // The action already reported the error; keep the text for another try.
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit();
    if (e.key === 'Escape') onCancel();
  };

  return (
    <form className="composer" onSubmit={submit}>
      {quote && <blockquote className="composer-quote">{quote}</blockquote>}
      <textarea
        autoFocus
        rows={3}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="composer-actions">
        <span className="hint">Ctrl+Enter 送出 · Esc 取消</span>
        <button type="button" className="btn ghost" onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="btn primary" disabled={!text.trim() || busy}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
