// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { contrastRatio, parseColor, readableMermaid, type ContrastPalette } from '../../src/web/mermaidContrast.js';
import { configFor, contrastPalette, LABEL_WRAP_WIDTH } from '../../src/web/mermaidConfig.js';

const DARK: ContrastPalette = { background: '#1f2226', text: '#e4e4e1', darkText: '#1f2328', lightText: '#e4e4e1' };
const LIGHT: ContrastPalette = { background: '#fffefb', text: '#1f2328', darkText: '#1f2328', lightText: '#e4e4e1' };

/** The `rgb(...)` colour on a `rect` line, parsed. */
const rectColor = (out: string) => parseColor(/rect (rgb\([^)]*\))/.exec(out)![1])!;

describe('parseColor', () => {
  it('reads hex, rgb() and hsl() colours', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColor('#e1f5fe')).toEqual({ r: 225, g: 245, b: 254 });
    expect(parseColor('rgb(255, 240, 200)')).toEqual({ r: 255, g: 240, b: 200 });
    expect(parseColor('rgb(255\\,0\\,0)')).toEqual({ r: 255, g: 0, b: 0 });
    expect(parseColor('#f9f !important')).toEqual({ r: 255, g: 153, b: 255 });
    expect(parseColor('hsl(0, 100%, 50%)')).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('composites translucent colours over the given background', () => {
    expect(parseColor('rgba(255, 255, 255, 0.5)', { r: 0, g: 0, b: 0 })).toEqual({ r: 128, g: 128, b: 128 });
    expect(parseColor('#ffffff00', { r: 10, g: 20, b: 30 })).toEqual({ r: 10, g: 20, b: 30 });
  });

  it('returns null for values that are not colours', () => {
    expect(parseColor('none')).toBeNull();
    expect(parseColor('transparent')).toBeNull();
    expect(parseColor('url(#grad)')).toBeNull();
    expect(parseColor('#12')).toBeNull();
  });
});

describe('readableMermaid', () => {
  it('gives light boxes dark text in dark mode', () => {
    const code = 'flowchart TD\n  A --> B\n  style A fill:#e1f5fe,stroke:#01579b\n  classDef warn fill:#ffcdd2;';
    expect(readableMermaid(code, DARK)).toBe(
      'flowchart TD\n  A --> B\n  style A fill:#e1f5fe,stroke:#01579b,color:#1f2328\n  classDef warn fill:#ffcdd2,color:#1f2328;',
    );
  });

  it('gives dark boxes light text in light mode', () => {
    expect(readableMermaid('flowchart LR\n  classDef dark fill:#263238', LIGHT)).toBe('flowchart LR\n  classDef dark fill:#263238,color:#e4e4e1');
  });

  it('leaves boxes alone when the theme text already reads well on them', () => {
    const darkBox = 'flowchart LR\n  style A fill:#263238';
    const lightBox = 'flowchart LR\n  classDef soft fill:#e1f5fe';
    expect(readableMermaid(darkBox, DARK)).toBe(darkBox);
    expect(readableMermaid(lightBox, LIGHT)).toBe(lightBox);
  });

  it("keeps an author's own text colour unless it is unreadable on its fill", () => {
    expect(readableMermaid('flowchart LR\n  style A fill:#1e88e5,color:#fff', DARK)).toBe('flowchart LR\n  style A fill:#1e88e5,color:#fff');
    expect(readableMermaid('flowchart LR\n  style A fill:#e3f2fd,color:#ffffff', LIGHT)).toBe('flowchart LR\n  style A fill:#e3f2fd,color:#1f2328');
  });

  it('handles rgb() fills with escaped commas and CRLF line endings', () => {
    expect(readableMermaid('flowchart LR\r\n  style A fill:rgb(255\\,240\\,200)\r\n', DARK)).toBe(
      'flowchart LR\r\n  style A fill:rgb(255\\,240\\,200),color:#1f2328\r\n',
    );
  });

  it('ignores lines without a readable fill and diagrams without styles', () => {
    expect(readableMermaid('flowchart LR\n  style A stroke:#f00', DARK)).toBe('flowchart LR\n  style A stroke:#f00');
    expect(readableMermaid('graph TD; A-->B', DARK)).toBe('graph TD; A-->B');
  });

  it('tones a light sequence rect toward the dark background until the messages read well', () => {
    const code = '%% comment\nsequenceDiagram\n  rect rgb(255, 240, 200)\n    A->>B: hi\n  end';
    const out = readableMermaid(code, DARK);
    const color = rectColor(out);
    expect(contrastRatio(color, parseColor('#e4e4e1')!)).toBeGreaterThanOrEqual(4.5);
    // Still a warm tint, not the plain background.
    expect(color.r).toBeGreaterThan(color.b);
    expect(color).not.toEqual(parseColor('#1f2226'));
    expect(out.replace(/rect rgb\([^)]*\)/, 'rect X')).toBe('%% comment\nsequenceDiagram\n  rect X\n    A->>B: hi\n  end');
  });

  it('keeps sequence rects that already work, and leaves `rect` alone outside sequence diagrams', () => {
    const subtle = 'sequenceDiagram\n  rect rgba(0, 0, 255, 0.1)\n  A->>B: hi\n  end';
    expect(readableMermaid(subtle, DARK)).toBe(subtle);
    const flow = 'flowchart LR\n  rect rgb(255, 255, 255)';
    expect(readableMermaid(flow, DARK)).toBe(flow);
  });
});

describe('Mermaid config', () => {
  it('wraps labels wider than Mermaid does, evenly across lines', () => {
    const cfg = configFor(false);
    expect(LABEL_WRAP_WIDTH).toBeGreaterThan(120);
    expect(cfg.flowchart?.wrappingWidth).toBe(LABEL_WRAP_WIDTH);
    expect(cfg.state?.wrappingWidth).toBe(LABEL_WRAP_WIDTH);
    expect(cfg.themeCSS).toContain('text-wrap-style: balance');
    // Mermaid lowercases selectors; an SVG element name would not match in the <img> the diagram is shown in.
    expect(cfg.themeCSS).not.toMatch(/foreignObject/i);
  });

  it('keeps the panel theme even when a diagram asks for another one', () => {
    expect(configFor(true).secure).toEqual(expect.arrayContaining(['theme', 'themeVariables', 'themeCSS', 'darkMode', 'securityLevel']));
  });

  it('every theme text colour reads well on its own background', () => {
    for (const dark of [false, true]) {
      const v = configFor(dark).themeVariables as Record<string, string>;
      const pairs: [string, string][] = [
        ['primaryTextColor', 'primaryColor'],
        ['textColor', 'background'],
        ['noteTextColor', 'noteBkgColor'],
        ['textColor', 'clusterBkg'],
      ];
      if (dark) {
        pairs.push(['taskTextDarkColor', 'doneTaskBkgColor'], ['taskTextDarkColor', 'activeTaskBkgColor'], ['taskTextDarkColor', 'critBkgColor']);
        for (let i = 0; i < 8; i++) pairs.push([`gitBranchLabel${i}`, `git${i}`]);
      } else {
        pairs.push(['textColor', 'critBkgColor']);
      }
      for (const [fg, bg] of pairs) {
        expect(contrastRatio(parseColor(v[fg])!, parseColor(v[bg])!), `${dark ? 'dark' : 'light'} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
      const p = contrastPalette(dark);
      expect(p.text).toBe(v.textColor);
      expect(p.background).toBe(v.background);
    }
  });
});
