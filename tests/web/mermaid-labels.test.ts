import { describe, expect, it } from 'vitest';
import { fitFlowchartLabels, labelFitOptions, layoutLabel, type MeasureText } from '../../src/web/mermaidLabels.js';

// A fixed-pitch stand-in for the browser: CJK characters 16px, everything else 8px.
const measure: MeasureText = (text) => [...text].reduce((w, ch) => w + (/[⺀-鿿＀-￯]/u.test(ch) ? 16 : 8), 0);
const opts = labelFitOptions(16);
const lines = (text: string, shape?: 'box' | 'diamond' | 'round') => layoutLabel(text, measure, opts, shape)!.lines;

describe('layoutLabel', () => {
  it('keeps short labels on one line', () => {
    expect(lines('使用者送出問題')).toEqual(['使用者送出問題']);
    expect(lines('Short label')).toEqual(['Short label']);
  });

  it('spreads a long CJK sentence evenly over a few lines', () => {
    const text = '當使用者在側邊面板針對某一段回覆提出追問時系統會建立一個唯讀的分支來回答這個問題';
    const out = lines(text);
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out.length).toBeLessThanOrEqual(4);
    expect(out.join('')).toBe(text);
    const lengths = out.map((l) => [...l].length);
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(2);
  });

  it('never breaks inside a dash-, dot- or slash-joined run that fits on a line', () => {
    const out = lines('請把 remote.hostnames 設成 agent-console-remote-workstation-01.corp.example.com 再重新啟動');
    expect(out).toContain('agent-console-remote-workstation-01.corp.example.com');
    expect(lines('run npm-run-build-and-verify-the-output-bundle-size')).toEqual(['run', 'npm-run-build-and-verify-the-output-bundle-size']);
    expect(lines('檢查 src/web/components/DiagramViewer.tsx 裡的 diagramSize').some((l) => l.includes('src/web/components/DiagramViewer.tsx'))).toBe(true);
  });

  it('splits a run wider than the widest line after its separators, and as a last resort anywhere', () => {
    const run = Array.from({ length: 12 }, (_, i) => `segment${i}`).join('-');
    const out = lines(run);
    expect(out.join('')).toBe(run);
    for (const l of out.slice(0, -1)) expect(l.endsWith('-')).toBe(true);
    for (const l of out) expect(measure(l)!).toBeLessThanOrEqual(opts.maxWidth);
    const solid = 'x'.repeat(100);
    expect(lines(solid).every((l) => measure(l)! <= opts.maxWidth)).toBe(true);
    expect(lines(solid).join('')).toBe(solid);
  });

  it('keeps CJK punctuation with the character it belongs to', () => {
    const out = lines('回覆完成後，停止鉤子會把結論打包，並送回主要的終端機視窗，讓主工作階段能看到。');
    for (const l of out.slice(1)) expect(l).not.toMatch(/^[，。]/);
    const quoted = lines('先讀「設定檔說明文件裡的遠端存取章節」再決定要不要匯入憑證到受信任的根憑證存放區');
    for (const l of quoted) expect(l).not.toMatch(/「$/);
  });

  it('keeps existing <br> breaks', () => {
    expect(lines('CLI<br/>主工作階段')).toEqual(['CLI', '主工作階段']);
  });

  it('keeps diamonds and circles compact rather than wide', () => {
    expect(lines('需要 fork 嗎？', 'diamond')).toEqual(['需要 fork 嗎？']);
    const text = '要不要把遠端存取的設定全部改掉並重新產生憑證';
    expect(lines(text, 'diamond').length).toBeGreaterThan(lines(text, 'box').length);
  });

  it('returns null when the text cannot be measured', () => {
    expect(layoutLabel('abc', () => null, opts)).toBeNull();
  });
});

describe('fitFlowchartLabels', () => {
  const long = '請把 remote.hostnames 設成 agent-console-remote-workstation-01.corp.example.com 再重新啟動';

  it('writes the chosen breaks into node and edge labels, and widens wrapping to keep them', () => {
    const code = `flowchart TD\n  A[${long}] --> B["${long}"]\n  B -->|${long}| C{短}\n  C --> D((完成))`;
    const fit = fitFlowchartLabels(code, measure, opts);
    const broken = lines(long).join('<br>');
    expect(fit.code).toBe(`flowchart TD\n  A[${broken}] --> B["${broken}"]\n  B -->|${broken}| C{短}\n  C --> D((完成))`);
    const widest = Math.max(...lines(long).map((l) => measure(l)!));
    expect(fit.wrappingWidth).toBeGreaterThan(widest);
    expect(fit.wrappingWidth).toBeLessThanOrEqual(widest + opts.fontSize);
  });

  it('uses the base width when every label is short', () => {
    expect(fitFlowchartLabels('graph TD; A[One]-->B[Two]', measure, opts)).toEqual({ code: 'graph TD; A[One]-->B[Two]', wrappingWidth: opts.baseWidth });
  });

  it('recognises the other node shapes and ids with dashes', () => {
    const code = `flowchart LR\n  my-node([${long}]) --> n2[[${long}]] --> n3[(${long})] --> n4{{${long}}} --> n5[/${long}/]`;
    const out = fitFlowchartLabels(code, measure, opts).code;
    expect(out.match(/<br>/g)!.length).toBe(5 * (lines(long).length - 1));
    expect(out).toContain('my-node([');
    expect(out).toContain('n5[/');
  });

  it('leaves markdown strings, HTML labels, styles, comments and other diagrams alone', () => {
    const code = [
      'flowchart TD',
      `  %% A[${long}]`,
      `  A["\`**${long}**\`"] --> B[<b>${long}</b>]`,
      '  style A fill:#e1f5fe,stroke-width:2px',
      `  subgraph S [${long}]`,
      '  end',
      `  C@{ shape: rect, label: "x" }`,
    ].join('\n');
    expect(fitFlowchartLabels(code, measure, opts).code).toBe(code);
    const seq = `sequenceDiagram\n  A->>B: ${long}`;
    expect(fitFlowchartLabels(seq, measure, opts)).toEqual({ code: seq, wrappingWidth: opts.baseWidth });
  });

  it('changes nothing when the text cannot be measured', () => {
    const code = `flowchart TD\n  A[${long}]`;
    expect(fitFlowchartLabels(code, () => null, opts)).toEqual({ code, wrappingWidth: opts.baseWidth });
  });

  it('sizes follow the font: a wider font gives wider lines', () => {
    const wide: MeasureText = (t) => measure(t)! * 1.25;
    const code = 'flowchart TD\n  A[當使用者在側邊面板針對某一段回覆提出追問時系統會建立一個唯讀的分支來回答這個問題]';
    expect(fitFlowchartLabels(code, wide, opts).wrappingWidth).toBeGreaterThan(fitFlowchartLabels(code, measure, opts).wrappingWidth);
  });
});
