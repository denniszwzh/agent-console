/**
 * Read-only command guard for forked review threads. Pure policy: every decision about which
 * shell commands a fork may run lives here. Anything not explicitly allowed is denied.
 */

export interface GuardDecision {
  allow: boolean;
  reason: string;
}

const deny = (reason: string): GuardDecision => ({ allow: false, reason });
const ALLOW: GuardDecision = { allow: true, reason: 'read-only command' };

// Searching is deliberately NOT here (grep/rg/find/Select-String): forks have the built-in Grep and
// Glob tools, and those commands' option surface (exec, pre-processors, -f files) is too large.
// Command names, POSIX tools are matched case-sensitively, PowerShell cmdlets case-insensitively.
const POSIX_COMMANDS = new Set(['git', 'ls', 'dir', 'cat', 'type', 'head', 'tail', 'wc']);
const CMDLETS = new Set(['get-content', 'get-childitem']);
const POWERSHELL_ALIASES: Record<string, string> = {
  cat: 'get-content', type: 'get-content', gc: 'get-content',
  ls: 'get-childitem', dir: 'get-childitem', gci: 'get-childitem',
};
const GIT_SUBCOMMANDS = new Set(['log', 'diff', 'show', 'status', 'blame', 'branch']);
const GIT_BRANCH_ARGS = new Set(['-a', '-r', '--list', '-v']);

// Long options that make git write files or run external programs. git accepts unambiguous
// abbreviations of long options, so any prefix of these (from "--xx" up) is rejected too.
const GIT_DENIED_LONG = ['--output', '--ext-diff', '--textconv', '--show-signature'];

// Policy: no shell-word parsing. Every character that could quote, escape, expand, redirect,
// chain or substitute is rejected outright, so whitespace tokenization yields literal tokens and
// the option denylists below are sound. `=` is rejected too (allowlisted tools take `--opt value`).
// Control characters (incl. tab, newline, C1 such as U+0085) are rejected. Glob characters * ? [ ] are rejected too: Bash would expand them
// into repo filenames that look like options (a file named `--output=a.txt`) after approval.
const FORBIDDEN_CHARS = /['"`\u2018-\u201f${}<>|;&()!#=@%*?[\]‐-―−\u0000-\u001f\u007f-\u009f]/;
// `~` is only meaningful (home expansion) at the start of a token, so HEAD~1 is fine.
const BACKSLASH = String.fromCharCode(92);
const WHITESPACE = /[\s\u0085\u2028\u2029\u00a0]+/u;

function longOptName(token: string): string {
  const eq = token.indexOf('=');
  return eq === -1 ? token : token.slice(0, eq);
}

function gitArgDenied(token: string): boolean {
  if (token.startsWith('--')) {
    const name = longOptName(token);
    return name.length >= 4 && GIT_DENIED_LONG.some((opt) => opt.startsWith(name));
  }
  // -o<file> (output) and -c (external config / combined diff) in any attached form.
  // -O<orderfile> reads an arbitrary (possibly UNC) path.
  return /^-[oc]/.test(token) || /^-[A-Za-z0-9]*O/.test(token);
}

function checkGit(args: string[]): GuardDecision {
  const sub = args[0];
  if (!sub || !GIT_SUBCOMMANDS.has(sub)) return deny(`git ${sub ?? ''}`.trim() + ' is not allowed');
  const rest = args.slice(1);
  if (sub === 'branch') {
    const bad = rest.find((a) => !GIT_BRANCH_ARGS.has(a));
    return bad === undefined ? ALLOW : deny(`git branch argument not allowed: ${bad}`);
  }
  const bad = rest.find(gitArgDenied);
  return bad === undefined ? ALLOW : deny(`git argument not allowed: ${bad}`);
}

function checkTail(args: string[]): GuardDecision {
  // Follow flags (also inside short clusters such as -nf) would hang until the tool times out.
  // GNU long options may be abbreviated: --f, --fo, --foll ... all mean --follow.
  const bad = args.find(
    (a) => /^-[A-Za-z0-9]*[fF]/.test(a) || (/^--[a-z]/.test(a) && 'follow'.startsWith(a.slice(2).split('=')[0])),
  );
  return bad === undefined ? ALLOW : deny(`tail argument not allowed: ${bad}`);
}

function checkCmdlet(command: string, args: string[]): GuardDecision {
  const lower = command.toLowerCase();
  if (lower.includes('invoke-')) return deny('Invoke-* is not allowed');
  if (args.some((a) => a.toLowerCase().startsWith('-command'))) return deny('-Command is not allowed');
  if (args.some((a) => /^-wa/i.test(a))) return deny('-Wait is not allowed');
  return ALLOW;
}

export function decideGuard(toolName: string, command: string): GuardDecision {
  if (toolName !== 'Bash' && toolName !== 'PowerShell') return deny(`tool not allowed: ${toolName}`);
  if (typeof command !== 'string') return deny('missing command');
  const cmd = command.trim();
  if (!cmd) return deny('empty command');
  if (FORBIDDEN_CHARS.test(cmd)) return deny('quoting, expansion, redirection, pipes and chaining are not allowed');
  // Backslash is an escape character in Bash but a path separator in PowerShell.
  if (toolName === 'Bash' && cmd.includes(BACKSLASH)) return deny('backslash escapes are not allowed');
  if (cmd.startsWith('. ')) return deny('dot-sourcing is not allowed');

  const [first, ...args] = cmd.split(WHITESPACE);
  const powershell = toolName === 'PowerShell';
  for (const t of [first, ...args]) {
    if (t.startsWith('~')) return deny('home expansion is not allowed');
    if (t.includes('//') || t.includes('::')) return deny('UNC paths and provider paths are not allowed');
    // Windows treats any mix of two leading separators (/\host, \/host) as UNC.
    const sep = (c: string | undefined) => c === '/' || c === BACKSLASH;
    if (sep(t[0]) && sep(t[1])) return deny('UNC paths are not allowed');
    if (t.includes('/' + BACKSLASH) || t.includes(BACKSLASH + '/')) return deny('mixed path separators are not allowed');
    if (t.includes(BACKSLASH + BACKSLASH) || (powershell && t.startsWith(BACKSLASH))) {
      return deny('UNC paths are not allowed');
    }
    if (powershell && t.startsWith('-') && t.includes(':')) return deny('attached parameter values are not allowed');
    if (t.includes('/dev/tcp') || t.includes('/dev/udp')) return deny('network device paths are not allowed');
  }

  if (powershell) {
    // cat/type/gc and ls/dir/gci are cmdlet aliases in PowerShell: apply the cmdlet checks to them too.
    const alias = POWERSHELL_ALIASES[first.toLowerCase()];
    if (alias) return checkCmdlet(cmd, args);
  }
  if (POSIX_COMMANDS.has(first)) {
    if (first === 'git') return checkGit(args);
    if (first === 'tail') return checkTail(args);
    return ALLOW;
  }
  if (CMDLETS.has(first.toLowerCase())) return checkCmdlet(cmd, args);
  return deny(`command not on the read-only allowlist: ${first}`);
}
