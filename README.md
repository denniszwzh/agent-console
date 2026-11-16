# Agent Console

A local review panel that sits next to the Claude Code / Codex CLI terminal.

Every time the agent finishes a turn, a hook sends the reply (and the files it wrote that turn) to a small
server on `127.0.0.1`. The browser panel renders it properly (Markdown, Mermaid, code highlighting, local
images) and lets you anchor questions on any paragraph. Each question runs in its own read-only fork of the
session, so the main conversation is never touched. When every thread is concluded you submit, and the
one-line conclusions go back to the main session as a single bundle.

Everything runs locally: the server listens on `127.0.0.1` only, the UI is bundled (no CDN), and every
`/api` call needs a token.

## Requirements

- Windows 11 (primary target; macOS/Linux should work but are not tested)
- Node.js 22
- Claude Code (tested with 2.1.302) and/or Codex CLI (tested with 0.167.0; the Codex `Interrupt` hook needs a version that has that event) on `PATH`
- git (used for the post-run change check; optional, the check is skipped outside a git repo)

## Build

```
npm install        # runs "prepare", which builds dist/
npm run build      # rebuild after changes
npm test           # vitest
```

To get the `agent-console` command on your `PATH`, install the package from its folder:

```
npm install -g .
```

(or run `node dist/cli/main.js` directly).

## Install the hooks

```
agent-console install
```

- Claude: adds a `Stop` and a `UserPromptSubmit` hook to `~/.claude/settings.json`.
- Codex: adds `Stop`, `UserPromptSubmit` and `Interrupt` hooks to `~/.codex/hooks.json` (`$CODEX_HOME` is honoured;
  skipped if the directory does not exist). The last two only drive the "responding" status.

Each file is shown as a before/after dump of its `hooks` section and only written after you confirm; a backup
(`<file>.agent-console-backup-<timestamp>`) is made first.

**Codex trust step:** Codex silently skips hooks it has not been told to trust. After installing, open the Codex
TUI once and run `/hooks` to review and trust the Agent Console hooks (`Stop`, `UserPromptSubmit`, `Interrupt`).
Until then Codex turns will not appear in the panel. Hooks added by a later `install` need the same trust step.

## Start

```
agent-console
```

Starts the server and opens the browser at `http://127.0.0.1:<port>/auth?token=...` (the console prints the same
URL). The token is stored in `~/.agent-console/token` and stays the same across restarts. Running `agent-console`
again while it is already running just opens the browser on the running instance. If the port is taken by another
program you get an `EADDRINUSE` message; change `port` in the config.

There is no start-at-login option; start it once per login.

## Configuration

`~/.agent-console/config.json` (the data directory can be moved with the `AGENT_CONSOLE_HOME` environment variable):

| Key | Default | Meaning |
| --- | --- | --- |
| `port` | `4317` | Port on `127.0.0.1`. |
| `concurrency` | `3` | Maximum number of fork runs at the same time. |
| `hardGate` | `false` | Claude only: block your next prompt while the latest review unit still has open threads (drafts count). |
| `runTimeoutMs` | `600000` | Upper bound for one fork run (answer or conclusion). On timeout the thread shows `Timed out after N min` and can be retried. |

## Hook time budget

The hooks never break the CLI. If the server is not running they exit silently. Each hook has a hard budget of
about 3 seconds (stdin read up to 1.5 s, each server call times out after 2 s, the process exits at 3 s no matter
what). Forked sessions (`AGENT_CONSOLE_FORK=1`) are ignored by the hooks.

## "Responding" status

When you send a prompt in a Claude or Codex session, the `UserPromptSubmit` hook tells the server. The sidebar marks the
session 「回應中」 (a session with no reply yet is listed too), and a banner above the reply shows the elapsed time and
the start of the prompt. If the session transcript has not grown for 3 minutes, the banner says the turn may be
waiting for a permission prompt or may have been interrupted. The `Stop` hook clears the status when the new reply
arrives. When you interrupt a turn, Codex runs its `Interrupt` hook, which clears the status. Claude Code has no such
hook and does not run `Stop` on an interrupt, so for Claude the server watches the lines appended to the transcript
and clears the status on the interrupt record. A turn whose transcript stays unchanged for an hour is dropped. The
state is in memory only (a restart forgets it). The Codex hooks print nothing, so they add nothing to the model's
context.

## How the conclusions get back

**Claude.** After you submit, send any next message in the terminal (for example "apply the review
conclusions"). The `UserPromptSubmit` hook injects the bundle into that turn. Delivery is two-phase: the hook writes
the bundle and then acknowledges it, and only the acknowledgement marks the unit as delivered, so a hook that is
killed half-way injects the same bundle again next time rather than losing it. The bundle starts with the absolute
path of the bundle file (`~/.agent-console/conclusions/<unit>.md`). If the session was `/clear`ed or closed, the panel
shows that path with a copy button so you can ask Claude to read it.

**Codex.** Codex has no prompt-injection hook. On submit the server tries `codex queue` once (10 s, best effort) with
an English instruction ("Read the review conclusions in <path> and apply them."). The panel always shows the same
instruction with a copy button; paste it into Codex if the next turn did not pick it up.

## Read-only forks

- Claude forks run with `--tools Read,Grep,Glob,Bash,PowerShell`, `--strict-mcp-config`, `--permission-mode default`,
  `--setting-sources project,local` (your user-level hooks and plugins stay out) and a `--settings` file with a
  PreToolUse guard for every tool: Read, Grep and Glob are left to Claude Code's normal permission checks (so a read
  outside the project folder is refused) except UNC and device paths, which are denied; Bash and PowerShell may run
  only a small read-only command list; every other tool is denied (the file also forces `disableAllHooks: false`, so
  a repository cannot switch the guard off).
- Forks keep the main session's tool definitions on purpose (no `--disallowedTools`): removing a tool changes the
  start of the request, so the fork could not reuse the main session's prompt cache and would pay to re-cache the
  whole conversation. `--tools` makes Claude Code refuse the other tools without changing the definitions, and the
  guard hook blocks them as a second layer. `scripts/measure-fork-cache.mjs` measures the cache reuse and probes the
  guard against the real CLI (it costs real tokens).
- Codex forks run with `-s read-only`, `--disable plugins`, `--disable apps`, `-c features.hooks=false` and every
  configured MCP server disabled by name.
- Before and after every run the server fingerprints `git status`; any change shows as a red warning in the panel.

## Uninstall

```
agent-console uninstall
```

Removes only the hooks that `install` added (with the same confirm-and-backup flow). Delete `~/.agent-console/` to
remove all data.

## Known limitations

- Claude plan-mode plans (ExitPlanMode) are not captured; plans written to files are.
- Answers stream per message, not per token.
- Only the newest review unit of a session can take new questions; older ones become read-only history and their
  open threads are marked expired.
- Codex: only `apply_patch` edits are detected as changed files, also when Codex applies the patch from code mode
  (read from the rollout's `FileChange` items). Files written by shell commands are not detected; add them with
  「+ 加入檔案」. A Codex turn without a rollout path yields no files; deletions (and, in older rollouts without `FileChange` items, the source of a move) are shown as errors. `codex queue` into a running TUI is best effort.
- Codex forks fail with a clear error if `codex mcp list` cannot be read or an MCP server name is not a plain
  `[A-Za-z0-9_-]` key (it could not be disabled).
- Managed (policy) Claude settings outrank the fork's own settings; a managed `disableAllHooks` would turn the guard off.
- Images are served from the live file (binary files are not snapshotted).
- No CLI version check at startup.
