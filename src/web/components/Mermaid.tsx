import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { readableMermaid } from '../mermaidContrast.js';
import { configFor, contrastPalette, LABEL_FIT, measureLabelText } from '../mermaidConfig.js';
import { fitFlowchartLabels } from '../mermaidLabels.js';
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
        // Labels broken into lines by their measured width; the wrapping width keeps those lines.
        const fitted = fitFlowchartLabels(code, measureLabelText, LABEL_FIT);
        // Set right before each render: the theme can change between renders.
        m.initialize(configFor(dark, fitted.wrappingWidth));
        return m.render(id, readableMermaid(fitted.code, contrastPalette(dark)));
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
        <div className="mermaid-error-message">Could not render the Mermaid diagram: {state.message}</div>
        <pre>
          <code>{code}</code>
        </pre>
      </div>
    );
  }
  return <div className="mermaid-loading">Loading diagram…</div>;
}
