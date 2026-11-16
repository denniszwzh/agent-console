import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { wellFormedSvg } from '../svg.js';
import { DiagramViewer } from './DiagramViewer.js';

type MermaidApi = typeof import('mermaid').default;
let mermaidReady: Promise<MermaidApi> | null = null;

const DARK_QUERY = '(prefers-color-scheme: dark)';

function darkQuery(): MediaQueryList | null {
  return typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null;
}

/** Follows the OS colour scheme, so diagrams switch theme together with the page. */
function usePrefersDark(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const q = darkQuery();
      q?.addEventListener?.('change', onChange);
      return () => q?.removeEventListener?.('change', onChange);
    },
    () => darkQuery()?.matches ?? false,
  );
}

// Mermaid is large, so it is loaded on first use (still from the local bundle).
function loadMermaid(): Promise<MermaidApi> {
  mermaidReady ??= import('mermaid').then(({ default: mermaid }) => mermaid);
  return mermaidReady;
}

function configFor(dark: boolean): Parameters<MermaidApi['initialize']>[0] {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    // The 'neo' look and themes: flatter shapes and calmer colours than the classic defaults.
    look: 'neo',
    theme: dark ? 'neo-dark' : 'neo',
    fontFamily: 'system-ui, "Segoe UI", "Microsoft JhengHei", sans-serif',
  };
}

type State = { kind: 'loading' } | { kind: 'ok'; svg: string } | { kind: 'error'; message: string };

export function Mermaid({ code }: { code: string }) {
  const id = `mmd-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [state, setState] = useState<State>({ kind: 'loading' });
  const dark = usePrefersDark();

  useEffect(() => {
    let live = true;
    setState({ kind: 'loading' });
    loadMermaid()
      .then((m) => {
        // Set right before each render: the theme can change between renders.
        m.initialize(configFor(dark));
        return m.render(id, code);
      })
      .then(({ svg }) => {
        if (live) setState({ kind: 'ok', svg: wellFormedSvg(svg) });
      })
      .catch((e: unknown) => {
        if (live) setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      live = false;
    };
  }, [id, code, dark]);

  if (state.kind === 'ok') return <DiagramViewer svg={state.svg} code={code} />;
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
