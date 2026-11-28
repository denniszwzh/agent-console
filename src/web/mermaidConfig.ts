import type { MermaidConfig } from 'mermaid';
import type { ContrastPalette } from './mermaidContrast.js';
import { labelFitOptions, type MeasureText } from './mermaidLabels.js';

function gitBranches(colors: string[], label: string): Record<string, string> {
  return Object.fromEntries(colors.flatMap((c, i) => [[`git${i}`, c], [`gitBranchLabel${i}`, label]]));
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
  noteTextColor: '#1f2328',
  // Gantt: the default critical bar is pure red, too dark for the dark task text.
  critBkgColor: '#f6cfca',
  critBorderColor: '#c0392b',
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
  noteTextColor: '#e4e4e1',
  // Gantt: the base theme keeps light grey / mid-blue / red bars in dark mode, under light text.
  taskTextColor: '#e4e4e1',
  taskTextDarkColor: '#e4e4e1',
  taskTextLightColor: '#e4e4e1',
  taskTextOutsideColor: '#e4e4e1',
  doneTaskBkgColor: '#3a3f46',
  doneTaskBorderColor: '#6b7078',
  activeTaskBkgColor: '#24506a',
  activeTaskBorderColor: '#5fa3c4',
  critBkgColor: '#6a2a2a',
  critBorderColor: '#d46a6a',
  // Git graph: branch colours dark enough for white branch labels.
  ...gitBranches(['#2f6f8f', '#9a5530', '#4f7a3f', '#7a4f99', '#99365f', '#2f7f75', '#7f6f22', '#555b63'], '#ffffff'),
};

/** Text colours for boxes the diagram colours itself (see mermaidContrast.ts). */
export function contrastPalette(dark: boolean): ContrastPalette {
  const theme = dark ? PANEL_DARK : PANEL_LIGHT;
  return { background: theme.background, text: theme.textColor, darkText: PANEL_LIGHT.textColor, lightText: PANEL_DARK.textColor };
}

/** Diagram font, and the label font size Mermaid uses (its default `fontSize`). */
export const DIAGRAM_FONT_FAMILY = 'system-ui, "Segoe UI", "Microsoft JhengHei", sans-serif';
export const LABEL_FONT_SIZE = 16;

/** Line breaking sizes for flowchart labels (see mermaidLabels.ts), in em of the label font. */
export const LABEL_FIT = labelFitOptions(LABEL_FONT_SIZE);

/**
 * Widest a label grows before Mermaid wraps it, when mermaidLabels.ts has not laid it out itself.
 * Mermaid's default (120px, about seven CJK characters) turns a sentence-long label into a tall,
 * narrow column; 15em (about 15 CJK characters or 30 Latin ones) keeps such labels at two or three lines.
 */
export const LABEL_WRAP_WIDTH = LABEL_FIT.baseWidth;

/**
 * Wrapped labels share their text evenly across the lines instead of leaving one or two characters on
 * the last line. Only the wrap style is set: the wrap mode stays Mermaid's, which measures a label on
 * one line first to decide whether it needs to wrap at all. HTML only occurs inside the labels'
 * <foreignObject>; that element is not named because Mermaid lowercases selectors, and the diagram is
 * shown as an image, where SVG element names match case-sensitively.
 */
const THEME_CSS = 'div, span, p { text-wrap-style: balance; }';

let probe: HTMLSpanElement | null = null;
const widths = new Map<string, number>();

/**
 * Measures label text with the browser's own text layout in the diagram font, so line widths follow
 * whatever fonts this computer actually uses (including CJK fallback). Null where there is no layout
 * (a test DOM reports every width as 0).
 */
export const measureLabelText: MeasureText = (text) => {
  const cached = widths.get(text);
  if (cached !== undefined) return cached;
  if (typeof document === 'undefined' || !document.body) return null;
  if (!probe) {
    probe = document.createElement('span');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = `position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre;line-height:1.5;font-size:${LABEL_FONT_SIZE}px;font-family:${DIAGRAM_FONT_FAMILY}`;
  }
  if (!probe.isConnected) document.body.appendChild(probe);
  probe.textContent = text;
  const w = probe.getBoundingClientRect().width;
  probe.textContent = 'M';
  if (probe.getBoundingClientRect().width === 0) return null;
  widths.set(text, w);
  return w;
};

/** `wrappingWidth`: from fitFlowchartLabels for a flowchart whose labels it laid out. */
export function configFor(dark: boolean, wrappingWidth = LABEL_WRAP_WIDTH): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    // A diagram's own `%%{init}%%` / front matter may not swap the theme: the panel palette is what
    // keeps its text readable in both colour schemes. Its `style` / `classDef` colours still apply.
    secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'theme', 'themeVariables', 'themeCSS', 'darkMode'],
    // The 'neo' look (rounded shapes, soft shadows) on the 'base' theme coloured with the panel palette.
    look: 'neo',
    theme: 'base',
    themeVariables: dark ? PANEL_DARK : PANEL_LIGHT,
    themeCSS: THEME_CSS,
    fontFamily: DIAGRAM_FONT_FAMILY,
    flowchart: { wrappingWidth },
    state: { wrappingWidth: LABEL_WRAP_WIDTH },
  };
}

