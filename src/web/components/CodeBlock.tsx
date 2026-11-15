import { useEffect, useState, type CSSProperties } from 'react';
import type { ThemedToken } from 'shiki/core';
import { highlight, normalizeLang } from '../highlight.js';

interface Props {
  code: string;
  lang?: string;
  /** When set, a line-number gutter starts at this number. */
  startLine?: number;
}

type Line = { content: string; htmlStyle?: ThemedToken['htmlStyle'] }[];

export function CodeBlock({ code, lang, startLine }: Props) {
  const name = normalizeLang(lang);
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null);

  useEffect(() => {
    setTokens(null);
    if (!name) return;
    let live = true;
    highlight(code, name)
      .then((t) => {
        if (live) setTokens(t);
      })
      .catch((e) => console.warn('[highlight] failed', e));
    return () => {
      live = false;
    };
  }, [code, name]);

  const lines: Line[] = tokens ?? code.split('\n').map((l) => [{ content: l }]);

  return (
    <pre className={`code-block${startLine !== undefined ? ' numbered' : ''}`}>
      {lang && <span className="code-lang">{lang}</span>}
      <code>
        {lines.map((line, i) => (
          <span className="line" key={i}>
            {startLine !== undefined && <span className="ln">{startLine + i}</span>}
            {line.map((t, j) => (
              <span key={j} style={t.htmlStyle as CSSProperties | undefined}>
                {t.content}
              </span>
            ))}
            {'\n'}
          </span>
        ))}
      </code>
    </pre>
  );
}
