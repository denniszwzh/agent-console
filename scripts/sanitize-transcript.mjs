#!/usr/bin/env node
// Turns a real Claude Code transcript or Codex rollout into a sample that can be shared as a test
// fixture: the record structure stays, the private content goes.
//
// Usage:
//   node scripts/sanitize-transcript.mjs <input.jsonl|.json> [output] [--max-text <n>]
//     output      defaults to <input name>.sanitized.jsonl (or .json) in the current folder
//     --max-text  cut masked free text to n characters (default 300; 0 keeps the full length)
//
// Runs on the machine that holds the transcript. Needs only Node 22, no install. Reads one file,
// writes one file, sends nothing anywhere. Look through the output before sharing it.
//
// What stays as it is:
//   - JSON keys, numbers, booleans, null, and the record layout (line order, nesting).
//   - Enum-like values (type, role, subtype, tool name, status, model, version, ...).
//   - Identifiers (session ids, uuids, tool call ids) and ISO timestamps. They are random or
//     dates, and the parsers match records by them.
//   - The markers Agent Console's parsers look for: injected tags such as <system-reminder>,
//     <pasted_content>, "[Request interrupted by user", "# AGENTS.md instructions", apply_patch
//     headers ("*** Update File: ..."), the conclusion hand-back sentence, and the words
//     rejected / failed / blocked.
// What changes:
//   - Paths: the drive or root, the separators, file extensions and numeric folder names stay;
//     every other folder or file name becomes d1, d2, ... The same name (compared
//     case-insensitively) always gets the same replacement, so cwd, file_path and patch paths
//     still match each other.
//   - All other text: letters become x / X (CJK characters become 字), digits become 0;
//     spaces, line breaks and punctuation stay. The same text always masks the same way.
//   - Strings that hold JSON (for example Codex tool arguments) are parsed and handled the same way.
//   - Embedded images become a 1x1 PNG.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Values of these keys are kept when they look like identifiers (see ENUM_VALUE). */
const ENUM_KEYS = new Set([
  'type', 'role', 'subtype', 'name', 'status', 'model', 'stop_reason', 'stop_sequence', 'level',
  'userType', 'version', 'permission_mode', 'cli_version', 'kind', 'promptSource', 'permissionMode',
  'source', 'originator', 'model_provider', 'media_type', 'operation', 'effort', 'phase', 'decision',
  'hook_event_name', 'entrypoint', 'service_tier', 'reasoning_effort', 'approval_policy',
  'sandbox_policy', 'mode', 'format', 'encoding', 'object', 'stopReason', 'content_type',
]);
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const ENUM_VALUE = /^[A-Za-z0-9_.:@+-]{1,80}$/;
/** Keys that hold identifiers; values that look like one are kept. */
const ID_KEY = /(^id$|Id$|_id$|^uuid$|Uuid$|^parentUuid$|^session$|^thread$)/;
const ID_VALUE = /^[A-Za-z0-9_-]{1,100}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
/** Keys whose string value is a path even when it is relative. */
const PATH_KEYS = new Set([
  'cwd', 'file_path', 'notebook_path', 'path', 'filePath', 'transcript_path', 'workdir',
  'move_path', 'dir', 'directory', 'root', 'agent_transcript_path', 'rollout_path',
]);
const ABS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/|~[\\/])/;
/** Folder names (lower case) that carry meaning for the parsers (worktree detection, agent folders). */
const KEEP_SEGMENTS = new Set([
  '.claude', '.codex', '.agent-console', 'worktrees', 'projects', 'sessions', '.git', 'node_modules',
  'users', 'home', 'tmp', 'appdata', 'local', 'roaming', 'temp', '.', '..', '~',
]);
/** Rollout and transcript file names are built from ids and dates only. */
const KEEP_FILE = /^(?:rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[A-Za-z0-9-]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Same list as INJECTED_TAGS in src/server/turn-prompts.ts (a test checks), plus pasted_content. */
export const INJECTED_TAGS = [
  'system-reminder', 'task-notification', 'command-name', 'command-message', 'command-args',
  'local-command-stdout', 'local-command-stderr', 'local-command-caveat', 'environment_context',
  'turn_aborted', 'subagent_notification', 'skill', 'user_instructions', 'bash-input', 'bash-stdout',
  'bash-stderr', 'ide_opened_file', 'ide_selection', 'ide_diagnostics', 'user-memory-input',
  'pasted_content',
];
/** Text fragments kept verbatim inside masked text. */
const PROTECTED = new RegExp(
  [
    `</?(?:${INJECTED_TAGS.join('|')})(?=[\\s>])[^>]*>`,
    '\\[Request interrupted by user[^\\]\\n]*\\]?',
    '# AGENTS\\.md instructions',
    '\\*\\*\\* (?:Begin Patch|End Patch|End of File)',
    '\\b(?:rejected|failed|blocked)\\b',
  ].join('|'),
  'gi',
);
const PATCH_LINE = /^(\*\*\* (?:Add File|Update File|Delete File|Move to): )(.+?)(\s*)$/;
const INSTRUCTION = /^(\s*Read the review conclusions in )(.+)( and apply them\.\s*)$/s;
/** Body lines kept per file of an apply_patch text (when --max-text is not 0). */
const PATCH_BODY_LINES = 6;
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

export function createSanitizer({ maxText = 300 } = {}) {
  const segments = new Map();
  const kept = new Map(); // key -> Set of verbatim values (for the review list)

  function note(key, value) {
    if (!kept.has(key)) kept.set(key, new Set());
    kept.get(key).add(value);
  }

  function segment(seg) {
    // Purely numeric names are kept: Codex files rollouts under sessions/YYYY/MM/DD.
    if (!seg || KEEP_SEGMENTS.has(seg.toLowerCase()) || /^[A-Za-z]:$/.test(seg) || /^\d{1,4}$/.test(seg) || KEEP_FILE.test(seg)) return seg;
    const dot = seg.lastIndexOf('.');
    const ext = dot > 0 && /^\.[A-Za-z0-9]{1,8}$/.test(seg.slice(dot)) ? seg.slice(dot) : '';
    const base = ext ? seg.slice(0, dot) : seg;
    const k = base.toLowerCase();
    if (!segments.has(k)) segments.set(k, `d${segments.size + 1}`);
    let out = segments.get(k);
    if (base === base.toUpperCase() && base !== base.toLowerCase()) out = out.toUpperCase();
    else if (/^\p{Lu}/u.test(base)) out = out[0].toUpperCase() + out.slice(1);
    return out + ext;
  }

  function sanitizePath(p) {
    return p.split(/([\\/]+)/).map((part, i) => (i % 2 ? part : segment(part))).join('');
  }

  function maskChars(s) {
    return s
      .replace(/\p{Extended_Pictographic}/gu, '*')
      .replace(/\p{L}|\p{N}/gu, (c) =>
        CJK.test(c) ? '字' : /\p{N}/u.test(c) ? '0' : /\p{Lu}/u.test(c) ? 'X' : 'x',
      );
  }

  function maskFree(s) {
    let out = '';
    let last = 0;
    for (const m of s.matchAll(PROTECTED)) {
      // Tags keep their name; attribute values (a pasted file name, say) are masked.
      const kept = m[0].startsWith('<') ? m[0].replace(/^(<\/?[\w-]+)([^>]*)>$/, (_, tag, attrs) => `${tag}${maskChars(attrs)}>`) : m[0];
      out += maskChars(s.slice(last, m.index)) + kept;
      last = m.index + m[0].length;
    }
    return out + maskChars(s.slice(last));
  }

  function truncate(s) {
    if (!maxText || s.length <= maxText) return s;
    // Never cut inside a protected marker: keep whole lines up to the limit, then mark the cut.
    let cut = s.lastIndexOf('\n', maxText);
    if (cut <= 0) cut = maxText;
    const closers = [...s.slice(cut).matchAll(/<\/(?:system-reminder|pasted_content)>/g)].map((m) => m[0]);
    return `${s.slice(0, cut)}\n[...]${closers.length ? `\n${[...new Set(closers)].join('\n')}` : ''}`;
  }

  function text(s) {
    const inst = INSTRUCTION.exec(s);
    if (inst) return inst[1] + sanitizePath(inst[2]) + inst[3];
    const lines = s.split('\n');
    if (!lines.some((l) => PATCH_LINE.test(l.replace(/\r$/, '')))) return truncate(maskFree(s));
    // apply_patch text: every "*** " line stays (with its path mapped); each file keeps only the
    // first few body lines, so a later file's header is never cut off.
    const out = [];
    let body = 0;
    for (const l of lines) {
      const cr = l.endsWith('\r') ? '\r' : '';
      const bare = cr ? l.slice(0, -1) : l;
      const m = PATCH_LINE.exec(bare);
      if (m) {
        out.push(m[1] + sanitizePath(m[2]) + m[3] + cr);
        body = 0;
      } else if (bare.startsWith('*** ')) {
        out.push(maskFree(bare) + cr);
      } else if (!maxText || body < PATCH_BODY_LINES) {
        out.push(maskFree(bare) + cr);
        body++;
      } else if (body++ === PATCH_BODY_LINES) {
        out.push('[...]');
      }
    }
    return out.join('\n');
  }

  function string(s, key, parent) {
    if (ISO_TIME.test(s)) return s;
    if (key && ID_KEY.test(key) && ID_VALUE.test(s)) return s;
    if (key && ENUM_KEYS.has(key) && ENUM_VALUE.test(s)) {
      note(key, s);
      return s;
    }
    if (key === 'data' && typeof parent?.media_type === 'string' && /^image\//.test(parent.media_type)) return TINY_PNG;
    if (/^data:image\/[\w.+-]+;base64,/.test(s)) return `data:image/png;base64,${TINY_PNG}`;
    if ((key && PATH_KEYS.has(key)) || (ABS_PATH.test(s) && !/\s/.test(s) && !s.includes('\n'))) {
      return sanitizePath(s);
    }
    const t = s.trim();
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try {
        return JSON.stringify(value(JSON.parse(t)));
      } catch {
        // Not JSON after all: mask as text.
      }
    }
    return text(s);
  }

  function value(v, key, parent) {
    if (typeof v === 'string') return string(v, key, parent);
    if (Array.isArray(v)) return v.map((x) => value(x, key, parent));
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        const nk = ABS_PATH.test(k) ? sanitizePath(k) : k;
        out[nk] = value(x, k, v);
      }
      return out;
    }
    return v;
  }

  /** One JSONL line; lines that are not JSON are masked as text. */
  function line(l) {
    const t = l.trim();
    if (!t) return l;
    try {
      return JSON.stringify(value(JSON.parse(t)));
    } catch {
      return maskFree(l);
    }
  }

  return { value, line, sanitizePath, report: () => ({ kept, segmentCount: segments.size }) };
}

function parseArgs(argv) {
  const opts = { maxText: 300, files: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--max-text') opts.maxText = Number(argv[++i]);
    else if (argv[i] === '-h' || argv[i] === '--help') opts.help = true;
    else opts.files.push(argv[i]);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || opts.files.length < 1 || !Number.isFinite(opts.maxText) || opts.maxText < 0) {
    console.error('Usage: node scripts/sanitize-transcript.mjs <input.jsonl|.json> [output] [--max-text <n>]');
    process.exit(opts.help ? 0 : 2);
  }
  const [input, given] = opts.files;
  const isJson = input.toLowerCase().endsWith('.json');
  const output = given ?? path.basename(input).replace(/\.(jsonl?|JSONL?)$/, '') + (isJson ? '.sanitized.json' : '.sanitized.jsonl');
  if (path.resolve(output) === path.resolve(input)) {
    console.error('The output must not be the input file.');
    process.exit(2);
  }
  const s = createSanitizer({ maxText: opts.maxText });
  const raw = fs.readFileSync(input, 'utf8');
  let out;
  let records;
  if (isJson) {
    out = `${JSON.stringify(s.value(JSON.parse(raw)), null, 2)}\n`;
    records = 1;
  } else {
    const lines = raw.split('\n');
    out = lines.map((l) => s.line(l.replace(/\r$/, ''))).join('\n');
    records = lines.filter((l) => l.trim()).length;
  }
  fs.writeFileSync(output, out);
  const { kept, segmentCount } = s.report();
  console.log(`Wrote ${output}: ${records} record(s), ${segmentCount} distinct path name(s) replaced.`);
  console.log('Kept as-is (besides ids and timestamps); check that nothing here is private:');
  for (const [k, vals] of [...kept].sort(([a], [b]) => a.localeCompare(b))) {
    const list = [...vals].sort();
    console.log(`  ${k}: ${list.slice(0, 30).join(', ')}${list.length > 30 ? `, ... (${list.length} in all)` : ''}`);
  }
  console.log('Open the output and look it over before sharing it.');
}

const key = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
if (process.argv[1] && key(path.resolve(process.argv[1])) === key(fileURLToPath(import.meta.url))) main();
