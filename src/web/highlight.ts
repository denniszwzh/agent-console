import { createHighlighterCore, type HighlighterCore, type ThemedToken } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

// Only these grammars are bundled; everything else renders as plain text.
const LANGS = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
};
type LangName = keyof typeof LANGS;

const ALIASES: Record<string, LangName> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript', typescript: 'typescript',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', javascript: 'javascript',
  json: 'json', jsonc: 'json', json5: 'json',
  md: 'markdown', markdown: 'markdown',
  yml: 'yaml', yaml: 'yaml',
  sh: 'bash', bash: 'bash', zsh: 'bash', shell: 'bash', shellscript: 'bash', console: 'bash',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell', powershell: 'powershell', pwsh: 'powershell',
  py: 'python', python: 'python',
  html: 'html', htm: 'html', xml: 'html',
  css: 'css',
  diff: 'diff', patch: 'diff',
};

export function normalizeLang(lang: string | undefined): LangName | null {
  return lang ? (ALIASES[lang.toLowerCase()] ?? null) : null;
}

let highlighter: Promise<HighlighterCore> | null = null;

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  });
  return highlighter;
}

const loaded = new Map<LangName, Promise<void>>();

/**
 * Tokenize code with light and dark colours. Each token carries the CSS
 * variables --shiki-light / --shiki-dark; styles.css picks one per colour scheme.
 */
export async function highlight(code: string, lang: LangName): Promise<ThemedToken[][]> {
  const hl = await getHighlighter();
  let ready = loaded.get(lang);
  if (!ready) {
    ready = LANGS[lang]().then((m) => hl.loadLanguage(m.default));
    loaded.set(lang, ready);
  }
  await ready;
  return hl.codeToTokens(code, {
    lang,
    themes: { light: 'github-light', dark: 'github-dark' },
    defaultColor: false,
  }).tokens;
}
