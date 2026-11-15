import { useEffect, useId, useState } from 'react';
import { svgDataUrl } from '../svg.js';

type MermaidApi = typeof import('mermaid').default;
let mermaidReady: Promise<MermaidApi> | null = null;

function prefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

// Mermaid is large, so it is loaded on first use (still from the local bundle).
function loadMermaid(): Promise<MermaidApi> {
  mermaidReady ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: prefersDark() ? 'dark' : 'default',
      fontFamily: 'system-ui, "Segoe UI", "Microsoft JhengHei", sans-serif',
    });
    return mermaid;
  });
  return mermaidReady;
}

type State = { kind: 'loading' } | { kind: 'ok'; svg: string } | { kind: 'error'; message: string };

export function Mermaid({ code }: { code: string }) {
  const id = `mmd-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let live = true;
    setState({ kind: 'loading' });
    loadMermaid()
      .then((m) => m.render(id, code))
      .then(({ svg }) => {
        if (live) setState({ kind: 'ok', svg });
      })
      .catch((e: unknown) => {
        if (live) setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      live = false;
    };
  }, [id, code]);

  if (state.kind === 'ok') {
    // Mermaid sizes the SVG with width=100% plus an inline max-width; keep that natural width.
    const natural = /max-width:\s*([\d.]+)px/.exec(state.svg)?.[1];
    // Rendered through <img>: the SVG cannot run scripts or touch the page.
    return (
      <figure className="mermaid">
        <img
          src={svgDataUrl(state.svg)}
          alt="Mermaid 圖表"
          style={natural ? { width: `${natural}px`, maxWidth: '100%' } : undefined}
        />
      </figure>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="mermaid-error">
        <div className="mermaid-error-message">Mermaid 圖表無法渲染：{state.message}</div>
        <pre>
          <code>{code}</code>
        </pre>
      </div>
    );
  }
  return <div className="mermaid-loading">圖表載入中…</div>;
}
