import { describe, expect, it } from 'vitest';
import { decideGuard } from '../../src/agents/guard.js';
import { guardFromStdin } from '../../src/hooks/claude-guard.js';

const allow = (cmd: string, tool = 'Bash') => decideGuard(tool, cmd).allow;

describe('decideGuard allowlist', () => {
  it.each([
    'git log -5',
    'git diff HEAD~1',
    'git show HEAD',
    'git status',
    'git blame src/a.ts',
    'git branch',
    'git branch -a',
    'git branch -r',
    'git branch --list',
    'git branch -v',
    'ls -la',
    'dir',
    'cat a.md',
    'type a.md',
    'head -n 5 a.md',
    'wc -l a.md',
    'git diff HEAD~1 -- docs/spec.md',
    '  git log -5  ',
  ])('allows %s', (cmd) => {
    expect(allow(cmd)).toBe(true);
  });

  it.each([`Get-Content docs${String.fromCharCode(92)}spec.md`, 'Get-Content a.md', 'get-content a.md', 'Get-ChildItem -Recurse .', 'Get-ChildItem src'])(
    'allows PowerShell %s',
    (cmd) => {
      expect(allow(cmd, 'PowerShell')).toBe(true);
    },
  );
});

describe('decideGuard rejects', () => {
  it.each([
    'echo x > f.txt',
    'cat a >> b',
    'cat a | sh',
    'ls; rm -rf .',
    'git status && del x',
    'ls || rm x',
    'ls `rm x`',
    'ls $(rm x)',
    'ls\nrm x',
    'ls\r\nrm x',
    'find . -delete',
    'find . -exec rm {} +',
    'find . -execdir rm {} +',
    'find . -ok rm {} ;',
    'find . -okdir rm {} ;',
    'find . -fprint out.txt',
    'find . -fprint0 out.txt',
    'find . -fprintf out.txt x',
    'find . -fls out.txt',
    'git log --output=x.txt',
    'git diff --output x.txt',
    'git diff --ext-diff',
    'git diff --textconv',
    'git diff --outp=x.txt',
    'git log -o x',
    'git -c core.pager=evil log',
    'git branch -D main',
    'git branch newbranch',
    'git branch -a extra',
    'git push',
    'git',
    'rg --pre ./evil.sh foo',
    'rg --pre=./evil.sh foo',
    'rg --pre-glob "*" foo',
    'rg --hostname-bin ./evil foo',
    'Set-Content a.md x',
    'Remove-Item a',
    'npm test',
    'rm a',
    '/bin/rm a',
    './x.exe',
    '.\\x.exe',
    'FOO=bar ls',
    'cat <(rm x)',
    '',
    '   ',
    'Git log',
    'LS',
  ])('rejects %j', (cmd) => {
    const r = decideGuard('Bash', cmd);
    expect(r.allow).toBe(false);
    expect(r.reason.length).toBeGreaterThan(0);
  });

  it.each([
    'Get-Content -Command x',
    'Get-ChildItem Invoke-Expression',
    'Get-ChildItem invoke-expression',
    'Get-Content a.md & b',
    '. Get-Content a.md',
    'Get-Content (Remove-Item a)',
    'Get-Content {Remove-Item a}',
    'Select-String -Path a -Pattern x -Command y',
    'Set-Content a.md x',
  ])('rejects PowerShell %j', (cmd) => {
    expect(allow(cmd, 'PowerShell')).toBe(false);
  });

  it.each(['Write', 'Edit', 'mcp__desktop-commander__write_file', 'Read', ''])('rejects tool %j', (tool) => {
    expect(allow('ls', tool)).toBe(false);
  });
});

describe('decideGuard quoting / expansion bypasses (fix round 1)', () => {
  const BS = String.fromCharCode(92);
  const both = [
    'find . "-delete"',
    "find . -del''ete",
    'find . $\'-delete\'',
    'find . -${x:=delete}',
    'git log -1 "--output=x.txt"',
    "git log -1 --out''put=x.txt",
    'git diff "--ext-diff"',
    'rg "--pre=rm" foo .',
    "git log -1 '--output=x.txt'",
    "rg '--pre=cmd' foo .",
    'cat ${x:=$\'\x24(touch pwned1)\'} ${x@P}',
    'cat ${x:=$\'a[\x24(touch pwned2)]\'} $[x]',
    'ls $HOME',
    'ls \u2018-x\u2019',
    'ls \u201cx\u201d',
    'ls !x',
    'ls #x',
    'ls a=b',
    'ls @x',
    'ls %x',
    'ls ~/x',
    'ls <x',
    'git log --output x.txt',
    'git log --show-signature',
    'rg -z foo',
    'rg --search-zip foo',
    'cat /dev/tcp/1.2.3.4/80',
    'cat /dev/udp/1.2.3.4/80',
    'ls\u0000x',
    'ls\u0007x',
  ];
  it.each(both)('rejects (Bash) %j', (cmd) => {
    expect(allow(cmd, 'Bash')).toBe(false);
  });
  it.each(both)('rejects (PowerShell) %j', (cmd) => {
    expect(allow(cmd, 'PowerShell')).toBe(false);
  });

  it.each([`find . -dele${BS}te`, `ls a${BS}b`, 'cat //host/share/x', 'cat //host/share/x'])('rejects (Bash) %j', (cmd) => {
    expect(allow(cmd, 'Bash')).toBe(false);
  });

  it.each([`Get-Content ${BS}host${BS}share${BS}x`, 'Get-Content //host/share/x', 'Get-Content -Command:x', 'Get-Content -command:x', 'Get-Content -CommandX y'])(
    'rejects (PowerShell) %j',
    (cmd) => {
      expect(allow(cmd, 'PowerShell')).toBe(false);
    },
  );

  it('splits on Unicode whitespace so NBSP cannot hide an option', () => {
    expect(allow('find .\u00a0-delete')).toBe(false);
    expect(allow('find .\u2028-delete')).toBe(false);
    expect(allow('find .\u0085-delete')).toBe(false);
  });

  it.each(['git log -5', 'git diff HEAD~1 -- docs/spec.md', 'git show HEAD', 'git blame src/a.ts', 'git status', 'ls -la src', 'cat docs/spec.md', 'head -n 20 a.md', 'wc -l a.md'])(
    'still allows (Bash) %j',
    (cmd) => {
      expect(allow(cmd, 'Bash')).toBe(true);
    },
  );
  it('still allows PowerShell Get-Content with a backslash path', () => {
    expect(allow(`Get-Content docs${BS}spec.md`, 'PowerShell')).toBe(true);
  });
});

describe('decideGuard round 2 (shrunk allowlist, globs, UNC, follow flags)', () => {
  const BS = String.fromCharCode(92);
  const bash = [
    'rg hello *',
    'rg -n TODO src',
    'rg foo src',
    'grep -rn foo src',
    'grep -f//host/share/x foo .',
    'rg -f//host/share/x .',
    'rg -z foo',
    'rg -.z foo',
    'rg -0z foo',
    'find victim -del*',
    'find . -name x',
    'git log *',
    'git log ?',
    'git diff --out*',
    'cat [-]delete',
    'cat a]',
    'git diff -O//host/share/x',
    'git diff -O orderfile',
    'git log -nO x',
    'cat a//b',
    'tail -f x',
    'tail -F x',
    'tail -nf 5 x',
    'tail --follow x',
    'tail --f x',
    'tail --fo x',
    'tail --foll x',
    'tail -n 5 --f x',
    'cat –Wait x',
    'ls −x',
    'ls ‐x',
    'cat a::b',
    'ls *',
    'ls a?',
  ];
  it.each(bash)('rejects (Bash) %j', (cmd) => {
    expect(allow(cmd, 'Bash')).toBe(false);
  });

  const ps = [
    'git diff --no-index /' + BS + 'host' + BS + 's' + BS + 'a b',
    'git blame --contents /' + BS + 'host' + BS + 's' + BS + 'x a',
    'Get-Content /' + BS + '.' + BS + 'UNC' + BS + 'host' + BS + 'share',
    'Get-Content ' + BS + '/host/s',
    'Get-Content –Wait x',
    'Get-Content —Wait x',
    'Get-Content ―Wait x',
    'Get-Content −Wait x',
    'cat -Wait x',
    'type -Wait x',
    'gc -Wait x',
    'cat -wait x',
    'cat -Command x',
    'ls -Wait x',
    'gci -Wait x',
    'dir -Wait x',
    'Get-Content -Path:' + BS + 'host' + BS + 'share' + BS + 'x',
    'Get-Content FileSystem::' + BS + 'host' + BS + 'share',
    'Get-Content -Wait x',
    'Get-Content -wait x',
    'Get-Content -Wa x',
    'Get-Content a' + BS + BS + 'b',
    'Get-Content -LiteralPath:x',
    'Get-ChildItem *',
    'Get-ChildItem -Filter *.md',
    'Get-ChildItem [a]',
    'Select-String -Path a.md -Pattern foo',
    'rg foo',
    'grep foo x',
    'find . -delete',
    'tail -f x',
    'git log *',
    'git diff -O' + BS + BS + 'host' + BS + 'x',
    'cat a//b',
  ];
  it.each(ps)('rejects (PowerShell) %j', (cmd) => {
    expect(allow(cmd, 'PowerShell')).toBe(false);
  });

  it('still allows the kept PowerShell forms', () => {
    expect(allow('Get-Content docs' + BS + 'spec.md', 'PowerShell')).toBe(true);
    expect(allow('Get-ChildItem src', 'PowerShell')).toBe(true);
    expect(allow('Get-ChildItem C:' + BS + 'repo' + BS + 'src', 'PowerShell')).toBe(true);
    expect(allow('git log -5', 'PowerShell')).toBe(true);
  });

  it('allows PowerShell aliases of the kept cmdlets', () => {
    expect(allow('cat a.md', 'PowerShell')).toBe(true);
    expect(allow('gc a.md', 'PowerShell')).toBe(true);
    expect(allow('gci src', 'PowerShell')).toBe(true);
    expect(allow('ls src', 'PowerShell')).toBe(true);
  });

});

describe('decideGuard round 4 (tail removed from the allowlist)', () => {
  // GNU tail's obsolete `+NUMf` syntax follows the file and hangs; forks use the Read tool instead.
  const tails = ['tail +f x', 'tail +5f x', 'tail +1f a.md', 'tail -n 5 a.md', 'tail a.md'];
  it.each(tails)('rejects (Bash) %j', (cmd) => {
    expect(allow(cmd, 'Bash')).toBe(false);
  });
  it.each(tails)('rejects (PowerShell) %j', (cmd) => {
    expect(allow(cmd, 'PowerShell')).toBe(false);
  });

  it('still allows head', () => {
    expect(allow('head -n 5 a.md', 'Bash')).toBe(true);
    expect(allow('head -n 5 a.md', 'PowerShell')).toBe(true);
  });
});

describe('guardFromStdin', () => {
  const decision = (raw: string) => guardFromStdin(raw).hookSpecificOutput;

  it('allows a safe Bash command', () => {
    const out = guardFromStdin(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }));
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('denies a write via PowerShell', () => {
    const raw = JSON.stringify({ tool_name: 'PowerShell', tool_input: { command: 'Set-Content a x' } });
    expect(decision(raw).permissionDecision).toBe('deny');
  });

  it.each(['not json', '', '{', 'null', '[]', '{}', '{"tool_name":"Bash"}', '{"tool_name":"Bash","tool_input":{"command":5}}'])(
    'fails closed on %j',
    (raw) => {
      const d = decision(raw);
      expect(d.permissionDecision).toBe('deny');
      expect(d.permissionDecisionReason.length).toBeGreaterThan(0);
    },
  );
});
