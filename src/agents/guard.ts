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

// Command names, POSIX tools are matched case-sensitively, PowerShell cmdlets case-insensitively.
const POSIX_COMMANDS = new Set(['git', 'grep', 'rg', 'ls', 'dir', 'cat', 'type', 'head', 'tail', 'wc', 'find']);
const CMDLETS = new Set(['get-content', 'get-childitem', 'select-string']);
const GIT_SUBCOMMANDS = new Set(['log', 'diff', 'show', 'status', 'blame', 'branch']);
const GIT_BRANCH_ARGS = new Set(['-a', '-r', '--list', '-v']);

// Long options that make git write files or run external programs. git accepts unambiguous
// abbreviations of long options, so any prefix of these (from "--xx" up) is rejected too.
const GIT_DENIED_LONG = ['--output', '--ext-diff', '--textconv'];
const RG_DENIED = new Set(['--pre', '--pre-glob', '--hostname-bin']);
const FIND_DENIED = new Set([
  '-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls',
]);

// Rejected anywhere in the raw command string (quoted or not): redirection, pipes, command
// chaining, substitution, process substitution, newlines and other control characters.
const FORBIDDEN_CHARS = /[>|;&`\n\r]|\$\(|<\(|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
// PowerShell also executes commands inside grouping and script blocks.
const POWERSHELL_FORBIDDEN_CHARS = /[(){}]/;

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
  return /^-[oc]/.test(token);
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

function checkRg(args: string[]): GuardDecision {
  const bad = args.find((a) => RG_DENIED.has(longOptName(a)));
  return bad === undefined ? ALLOW : deny(`rg argument not allowed: ${bad}`);
}

function checkFind(args: string[]): GuardDecision {
  const bad = args.find((a) => FIND_DENIED.has(a));
  return bad === undefined ? ALLOW : deny(`find argument not allowed: ${bad}`);
}

function checkCmdlet(command: string, args: string[]): GuardDecision {
  const lower = command.toLowerCase();
  if (lower.includes('invoke-')) return deny('Invoke-* is not allowed');
  if (args.some((a) => a.toLowerCase() === '-command')) return deny('-Command is not allowed');
  return ALLOW;
}

export function decideGuard(toolName: string, command: string): GuardDecision {
  if (toolName !== 'Bash' && toolName !== 'PowerShell') return deny(`tool not allowed: ${toolName}`);
  if (typeof command !== 'string') return deny('missing command');
  const cmd = command.trim();
  if (!cmd) return deny('empty command');
  if (FORBIDDEN_CHARS.test(cmd)) return deny('redirection, pipes, chaining and substitution are not allowed');
  if (toolName === 'PowerShell' && POWERSHELL_FORBIDDEN_CHARS.test(cmd)) {
    return deny('grouping and script blocks are not allowed in PowerShell');
  }
  if (cmd.startsWith('. ')) return deny('dot-sourcing is not allowed');

  const [first, ...args] = cmd.split(/\s+/);
  if (POSIX_COMMANDS.has(first)) {
    switch (first) {
      case 'git': return checkGit(args);
      case 'rg': return checkRg(args);
      case 'find': return checkFind(args);
      default: return ALLOW;
    }
  }
  if (CMDLETS.has(first.toLowerCase())) return checkCmdlet(cmd, args);
  return deny(`command not on the read-only allowlist: ${first}`);
}
