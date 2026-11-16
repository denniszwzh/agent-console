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

/**
 * Diagram colours taken from the panel's own palette (styles.css :root, light and dark), so a
 * diagram reads as part of the page: accent-blue boxes on the panel's surface colour.
 */
const PANEL_LIGHT = {
  background: '#fffefb',
  primaryColor: '#e5eff3',
  primaryBorderColor: '#2f6f8f',
  primaryTextColor: '#1f2328',
  secondaryColor: '#f1f6f8',
  tertiaryColor: '#f6f7f8',
  lineColor: '#6b7078',
  textColor: '#1f2328',
  clusterBkg: '#f6f7f8',
  clusterBorder: '#c9c5bb',
  edgeLabelBackground: '#fffefb',
  actorBkg: '#e5eff3',
  actorBorder: '#2f6f8f',
  signalColor: '#3d434a',
  noteBkgColor: '#fff3d6',
  noteBorderColor: '#e0c27a',
};
const PANEL_DARK = {
  darkMode: true,
  background: '#1f2226',
  primaryColor: '#1d3542',
  primaryBorderColor: '#5fa3c4',
  primaryTextColor: '#e4e4e1',
  secondaryColor: '#24282d',
  tertiaryColor: '#24282d',
  lineColor: '#9298a0',
  textColor: '#e4e4e1',
  clusterBkg: '#24282d',
  clusterBorder: '#3a3f46',
  edgeLabelBackground: '#1f2226',
  actorBkg: '#1d3542',
  actorBorder: '#5fa3c4',
  signalColor: '#c9cbc8',
  noteBkgColor: '#3a3220',
  noteBorderColor: '#8a6d2a',
};

function configFor(dark: boolean): Parameters<MermaidApi['initialize']>[0] {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    // The 'neo' look (rounded shapes, soft shadows) on the 'base' theme coloured with the panel palette.
    look: 'neo',
    theme: 'base',
    themeVariables: dark ? PANEL_DARK : PANEL_LIGHT,
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
        <div className="mermaid-error-message">Could not render the Mermaid diagram: {state.message}</div>
        <pre>
          <code>{code}</code>
        </pre>
      </div>
    );
  }
  return <div className="mermaid-loading">Loading diagram…</div>;
}
