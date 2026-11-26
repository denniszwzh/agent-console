# Agent Console

A local review panel that sits next to the Claude Code / Codex CLI terminal.

Every time the agent finishes a turn, a hook sends the reply (and the files it wrote that turn) to a small
server on `127.0.0.1`. The browser panel renders it properly (Markdown, Mermaid, code highlighting, local
images) and lets you anchor questions on any paragraph. Each question runs in its own read-only fork of the
session, so the main conversation is never touched. When you want the main session to know what came out of them,
one click integrates a one-line conclusion per thread and sends them back as a single bundle.

Everything runs locally: the server listens on `127.0.0.1` only, the UI is bundled (no CDN), and every
`/api` call needs a token. An optional password-protected HTTPS entry for other computers is off by default (see
"Remote access").

## Requirements

- Windows 11 is the primary target. macOS and Linux should work but are not tested.
- [Node.js](https://nodejs.org/) 22 or newer, with npm.
- [git](https://git-scm.com/), to clone the repository. The server also uses it for the post-run change check;
  outside a git repository that check is skipped.
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (tested with 2.1.302) and/or
  [Codex CLI](https://github.com/openai/codex) (tested with 0.167.0; the Codex `Interrupt` hook needs a version
  that has that event), installed and signed in, with `claude` / `codex` on your `PATH`. The read-only forks run
  these same commands under your own account.

Nothing else is needed: every dependency comes from the public npm registry, and the panel is built locally (no CDN).

## Getting started

### 1. Clone and build

```
git clone https://github.com/denniszwzh/agent-console.git
cd agent-console
npm install
```

`npm install` also builds the server, hooks and panel into `dist/` (the `prepare` script). Keep this folder: the
hooks you install in step 3 run the scripts in its `dist/hooks/`, so moving or deleting the folder breaks them (see
"Update" and "Uninstall" below).

Optional check: `npm test` runs the test suite (a few tests call the real `git`).

### 2. Put the `agent-console` command on your PATH

```
npm install -g .
```

This links the global command to this folder. If your npm prefix needs administrator rights (common on Linux and
macOS with a system Node), use a Node version manager instead, or skip this step and run `node dist/cli/main.js`
wherever this README says `agent-console`.

### 3. Install the hooks

```
agent-console install
```

- Claude: adds a `Stop` and a `UserPromptSubmit` hook to `~/.claude/settings.json`.
- Codex: adds `Stop`, `UserPromptSubmit` and `Interrupt` hooks to `~/.codex/hooks.json` (`$CODEX_HOME` is honoured;
  skipped if the directory does not exist, so run Codex once first). The last two only drive the "responding"
  status.

Each file is shown as a before/after dump of its `hooks` section and only written after you confirm; a backup
(`<file>.agent-console-backup-<timestamp>`) is made first. Existing hooks of other tools are kept. Every command
the installer writes points at this folder's `dist/hooks/` and ends with `--agent-console-hook`, which is how
`uninstall` finds them again.

**Codex trust step:** Codex silently skips hooks it has not been told to trust. After installing, open the Codex
TUI once and run `/hooks` to review and trust the Agent Console hooks (`Stop`, `UserPromptSubmit`, `Interrupt`).
Until then Codex turns will not appear in the panel. Hooks added or changed by a later `install` need the same
trust step.

### 4. Start the panel

```
agent-console
```

Starts the server and opens the browser at `http://127.0.0.1:<port>/auth?token=...` (the console prints the same
URL). The token is stored in `~/.agent-console/token` and stays the same across restarts. Opening that URL once per
browser profile signs the browser in (it sets a cookie); after that `http://127.0.0.1:<port>/` is enough. Running
`agent-console` again while it is already running just opens the browser on the running instance. If the port is
taken by another program you get an `EADDRINUSE` message; change `port` in the config.

Keep it running while you work. There is no start-at-login option; start it once per login.

Other commands:

| Command | What it does |
| --- | --- |
| `agent-console install` / `uninstall` | Add / remove the hooks (step 3 and "Uninstall"). |
| `agent-console set-password` | Set the user name and password for the external entry (see "Remote access"). Signs out every remote device. |
| `agent-console logout-all` | Sign out every remote device without changing the password. |

### 5. Use it with Claude Code or Codex

Work in the terminal as usual (`claude` or `codex`, in any project folder). Each time the agent finishes a turn, the
reply appears in the panel under its project, with the files it changed as tabs. Select text in the reply or a file,
ask, and press **Send**; the answer comes from a read-only fork of that session. When you want the main session to
act on what you found, press **Integrate conclusions** and then send your next message in the terminal (see "Asking and
integrating conclusions" and "How the conclusions get back").

### Update

```
git pull
npm install
```

`npm install` rebuilds `dist/`. Restart the panel afterwards (stop the running `agent-console` process and start it
again). The hooks keep working as long as the folder stays where it is; if a new version changes them, run
`agent-console install` again (and repeat the Codex trust step).

### Uninstall

Remove the hooks before you delete the folder:

```
agent-console uninstall
npm uninstall -g agent-console
```

`uninstall` removes only the hooks that `install` added (with the same confirm-and-backup flow). Then delete the
folder, and `~/.agent-console/` to remove all data.

## Configuration

`~/.agent-console/config.json` (the data directory can be moved with the `AGENT_CONSOLE_HOME` environment variable):

| Key | Default | Meaning |
| --- | --- | --- |
| `port` | `4317` | Port on `127.0.0.1`. |
| `concurrency` | `3` | Maximum number of fork runs at the same time. |
| `hardGate` | `false` | Claude only: block your next prompt while a review thread of the latest reply is still being answered, or its conclusions are being integrated. |
| `runTimeoutMs` | `600000` | Upper bound for one fork run (answer or conclusion). On timeout the thread shows `Timed out after N min` and can be retried. |
| `remote` | not set | Optional object that turns on the external (HTTPS) entry; see "Remote access". |
| `remote.enabled` | `false` | The external entry starts only when this is exactly `true`. |
| `remote.hostnames` | none (required) | Non-empty list of the host names or IP addresses clients use to reach this computer. Bare names only: no scheme, port, path or `%zone`. They go into the self-signed certificate and are the only `Host` values the external entry accepts. |
| `remote.port` | `4318` | HTTPS port, an integer from 1 to 65535. |
| `remote.bindHost` | `0.0.0.0` | Address to listen on (all IPv4 interfaces by default). Use a specific address to limit it to one network interface. |
| `remote.sessionDays` | `30` | How long a remote sign-in lasts, an integer from 1 to 3650. Each use extends it (sliding expiry). |
| `remote.certFile`, `remote.keyFile` | not set | PEM certificate and private key of your own (for example a company certificate). Set both or neither. |

## Remote access

By default Agent Console is reachable only from this computer. You can additionally open an HTTPS entry, protected by
a user name and password, so that you can use the same panel from another computer. It is off until you turn it on,
and the local entry (`127.0.0.1`, token) keeps working exactly as before.

The external entry serves the same panel and API, but it accepts only a password sign-in. It never accepts the local
token, and it answers `403` to any `Host` or `Origin` that is not one of `remote.hostnames`.

### Turn it on

1. Set the user name and password (on the computer that runs Agent Console):

   ```
   agent-console set-password
   ```

   It asks for a user name (defaulting to the current one), a new password of at least 12 characters, and a
   confirmation. Only a scrypt hash is stored (`~/.agent-console/auth.json`). Typed passwords are not echoed on a
   terminal; if standard input is piped, the input is visible and the command says so.

2. Add a `remote` object to `~/.agent-console/config.json`:

   ```json
   {
     "remote": {
       "enabled": true,
       "hostnames": ["my-workstation", "192.168.1.20"],
       "port": 4318,
       "sessionDays": 30
     }
   }
   ```

   `hostnames` must list every name or address you will type in the other computer's browser. Only `enabled` and
   `hostnames` are required; the other keys are optional (see the Configuration table).

3. Allow the port through the Windows firewall. Run this yourself in an elevated PowerShell (Run as administrator);
   Agent Console never changes system or firewall settings:

   ```powershell
   New-NetFirewallRule -DisplayName "Agent Console remote" -Direction Inbound -Protocol TCP -LocalPort 4318 -Action Allow
   ```

   Use your own `remote.port` if you changed it. You can narrow the rule with `-RemoteAddress` or `-Profile Private`.

4. Start (or restart) `agent-console`. The console prints the certificate location and fingerprint, then one address
   per host name:

   ```
   Remote access certificate: C:\Users\you\.agent-console\tls\cert.pem (SHA-256 AB:CD:...)
   Remote access: https://my-workstation:4318/
   ```

   Open that address on the other computer and sign in. The browser stays signed in for `sessionDays` days (each
   visit extends it).

If the external entry cannot start, the console prints `Remote access is off: <reason>` and only that entry is
skipped; the local panel still starts. Typical reasons: no password is set yet, an invalid `remote` value, an
unreadable or mismatched `certFile` / `keyFile`, or the port is already in use.

### Trust the certificate

Unless you configure `certFile` and `keyFile`, Agent Console creates a self-signed certificate for `remote.hostnames`
in `~/.agent-console/tls/` (`cert.pem` and `key.pem`). It is valid for 2 years and is renewed automatically at the
next start when less than 30 days remain, when it no longer matches `remote.hostnames`, or when its files are
unusable. Browsers do not trust it by default, so on the other computer do one of these:

- Import it once (recommended). Copy `cert.pem` from the workstation to the client (never `key.pem`), then in
  PowerShell on the client, for the current user:

  ```powershell
  Import-Certificate -FilePath .\cert.pem -CertStoreLocation Cert:\CurrentUser\Root
  ```

  This places it in "Trusted Root Certification Authorities" for your account; Windows asks you to confirm. Browsers
  that use the Windows store (Edge, Chrome) then accept the address without a warning.
- Or click through the browser warning once, after checking that the certificate's SHA-256 fingerprint shown by the
  browser equals the one the console printed at startup.

Whenever the certificate is regenerated (the console then prints "A new self-signed certificate was created"), every
client has to trust the new one again in the same way.

To use a certificate your clients already trust (for example a company one), set both `remote.certFile` and
`remote.keyFile` to PEM files. Agent Console then uses them as they are, never creates or renews anything, and the
host names you connect with must be covered by that certificate. Use absolute paths (in JSON, forward slashes or
escaped backslashes; `~` is not expanded), and restart agent-console after setting `certFile` and `keyFile`.

### Security notes

- Signing in remotely gives the same powers as the local panel: asking threads (read-only forks that run under your
  account), sending, and integrating conclusions. Treat the password like a key to this computer's sessions and use a
  unique one.
- Five failed sign-ins from one IP address within 15 minutes lock that address out for 15 minutes, and every failed
  sign-in is answered after about a second.
- The session cookie is `__Host-ac_session` (`Secure`, `HttpOnly`, `SameSite=Strict`). Only a hash of each session id
  is stored (`~/.agent-console/sessions.json`).
- `agent-console set-password` signs out every device, and so does `agent-console logout-all`, which keeps the
  password. A running server notices either within a few seconds; open panels return to the sign-in screen. The
  panel's own **Sign out** button ends only that browser's session. If a device is lost or you think the session
  cookie leaked, run `agent-console logout-all`.
- HTTPS protects the password in transit, but expose the port only to networks you trust (a home or office LAN, or a
  VPN). Do not forward it to the internet.

## Hook time budget

The hooks never break the CLI. If the server is not running they exit silently. Each hook has a hard budget of
about 3 seconds (stdin read up to 1.5 s, each server call times out after 2 s, the process exits at 3 s no matter
what). Forked sessions (`AGENT_CONSOLE_FORK=1`) are ignored by the hooks.

## "Responding" status

When you send a prompt in a Claude or Codex session, the `UserPromptSubmit` hook tells the server. The sidebar marks the
session **Responding** (a session with no reply yet is listed too), and a banner above the reply shows the elapsed time and
the start of the prompt. If the session transcript has not grown for 3 minutes, the banner says the turn may be
waiting for a permission prompt or may have been interrupted. The `Stop` hook clears the status when the new reply
arrives. When you interrupt a turn, Codex runs its `Interrupt` hook, which clears the status. Claude Code has no such
hook and does not run `Stop` on an interrupt, so for Claude the server watches the lines appended to the transcript
and clears the status on the interrupt record. A turn whose transcript stays unchanged for an hour is dropped. The
state is kept in memory. After a restart the server reads the end of each known session's transcript (changed in the
last hour): a turn started after the session's last reply and not yet ended (Claude: no Stop, end-of-turn or interrupt
record; Codex: a `task_started` without `task_complete` or `turn_aborted`) is marked responding again, from its
original start time. A session that has never replied is not known after a restart and shows up again with its next
prompt. A turn started by another session's message or a background task shows that as its label instead of the raw
message. The Codex hooks print nothing, so they add nothing to the model's context.

## Session names and the quick switcher

Each session is listed under the agent's own name for it. For Claude this is the last `custom-title` record in the
transcript (set by the desktop app or `/rename`), else the last `ai-title` record (generated by Claude Code). For Codex
it is the latest `thread_name` for the thread in `~/.codex/session_index.jsonl`. A session without a name shows its
first prompt in a lighter style, or the folder name if there is none. The server also reads the session's start time
(the first transcript record) and its last change (the transcript's modification time). It finds the transcript from
the path the hooks report, else by searching `~/.claude/projects` (or `CLAUDE_CONFIG_DIR`) and `~/.codex/sessions`
(or `CODEX_HOME`). It reads only the first 256 KB and the last 4 MB of a transcript, then only what is appended.

Hold **Alt** and press **S** to open the quick switcher. It lists every session, the most recently changed first, with
its name, folder, start time, last change (e.g. "3 min ago"), and live status: Responding (with elapsed time), review
threads being answered, and the state of the latest reply. While still holding Alt, click a session to
open it. Releasing Alt, pressing Esc, or switching away from the window closes the switcher. The shortcut
works only while the panel's browser tab has focus.

## Sidebar groups and the conversation view

The sidebar groups sessions by project. A session's project is the folder holding its `.git`; a git worktree (including
Claude Code's `.claude/worktrees/<name>`, even after it was deleted) is listed under its main repository with the
worktree name on its second line. Groups are ordered by their newest reply, and each group can be collapsed (the
panel remembers it). Claude sessions are marked in orange, Codex sessions in green.

Selecting a session shows the whole session as one conversation, like the terminal: each turn's prompts, then the
agent's reply, oldest first, opened at the bottom. Scrolling up loads earlier turns. A new reply is followed when the
view is at the bottom; otherwise a **↓ New reply** button appears. Only the newest turn can be reviewed while it is open:
its changed files are tabs above the conversation, and **Integrate conclusions** and **+ Add file** belong to it. Earlier
turns are read-only; their changed files open as temporary tabs.

The prompts come from the agent's transcript. The server reads them when a reply arrives, and fills in earlier
replies in the background after it starts. It skips text the agents inject (system reminders, environment context,
AGENTS.md, interrupt markers) and shows Agent Console's own "apply the review conclusions" message as a marker. The
first reply of a session shows only the prompt just before it; a turn keeps at most its five newest prompts.

The panel remembers the selected session and the reading position for each browser tab, so reloading a tab (F5)
returns it to the same place even when other tabs show other sessions. A new tab starts where any tab was last.

Several tabs can be open at once. They share one live connection to the server (one tab holds it and passes the
events on; when that tab closes, another takes over), so they do not use up the browser's six connections per host.

### Reading width

Long lines on a wide screen are tiring to read, so the conversation's text column can be made narrower:

- Drag either edge of the column (faint handles appear when the mouse is over the conversation). Both edges move
  together. Double-click a handle to return to full width.
- Or press **Alt+[** (narrower), **Alt+]** (wider) and **Alt+0** (full width). The shortcuts do nothing while a text
  field has focus, and they use the physical bracket keys, so they work on other keyboard layouts too.

The width is a maximum, not a share of the screen: on a screen narrower than the chosen width the text simply fills
the screen. The wide layout and the portrait / narrow layout remember separate widths (the latter starts at full width),
so tuning one never squeezes the other. The width is kept per browser and shared by all sessions; the local and the
remote address keep their own. File tabs always use the full width.

## Files changed outside the edit tools

The agent's own edit records (Claude `Write`/`Edit`, Codex `apply_patch`) miss files written by shell commands. So
when a turn ends, the server also looks for files modified since the prompt (the time the `UserPromptSubmit` hook
reported; without it there is no scan):

- In a git work tree: files under the session folder that `git status` lists as changed or untracked
  (`.gitignore` is honoured) and whose modification time is after the prompt. They are marked as found through git.
  If git is there but cannot report (not installed, an untrusted `safe.directory`, a 2-second timeout), nothing is
  scanned, rather than falling back to a walk that would ignore `.gitignore`.
- Elsewhere: the session folder is walked (at most 20,000 entries or 1 second; `node_modules`, `dist`, `build`,
  `.venv` and similar folders are skipped, and the home folder or a drive root is never walked). These files are
  marked "maybe", because a modification time cannot tell who made the change.

Both ways also pick up files you or another program changed during the turn (a second agent session in the same
folder included). Symlinks are not followed, secret-looking names (`.env*`, `*.pem`, `*.key`, `*credential*`,
`auth.json`, `token.json`, SSH keys, `.npmrc`) are left out, and nothing in `~/.claude`, `~/.codex` or the Agent
Console data folder is scanned. At most 30 files are added per turn, newest first; the panel says how many were left
out and whether the walk ran out of budget. Deleted files are not listed.

## Asking and integrating conclusions

Select text in a reply, a changed file or an answer (or use **Ask** on a paragraph), type the question and press
**Send**: the thread is created and its fork starts answering at once. A question on an answer opens a nested thread,
forked from that answer's session. In an answered thread, **Follow up** continues in the same fork. Each thread is sent on
its own, whenever you like; there are no drafts to collect first.

Nothing goes back to the main session until you press **Integrate conclusions** at the bottom right of the conversation. It can be
pressed when the latest reply is still under review, at least one thread has its answer, and no thread is still being
answered (the bar says how many are). Agent Console then writes a one-line conclusion for every answered thread,
reusing each thread's fork (children first, so a parent's conclusion includes its children's), and submits them
together. Threads whose answer failed, and unsent drafts left from older versions, are left out and do not block it.
While it runs, the bar shows the progress and the threads cannot be changed. If a conclusion fails, the integration
stops, the thread stays answered and the bar says why; pressing it again only redoes the threads without a conclusion.
A restart during an integration counts as such a failure.

If you do not integrate and the main session moves on, the earlier reply becomes read-only history: its questions
and answers stay readable, and nothing from them reaches the main session.

## How the conclusions get back

**Claude.** After the conclusions are integrated, send any next message in the terminal (for example "apply the review
conclusions"). The `UserPromptSubmit` hook injects the bundle into that turn. Delivery is two-phase: the hook writes
the bundle and then acknowledges it, and only the acknowledgement marks the unit as delivered, so a hook that is
killed half-way injects the same bundle again next time rather than losing it. The bundle starts with the absolute
path of the bundle file (`~/.agent-console/conclusions/<unit>.md`). If the session was `/clear`ed or closed, the panel
shows that path with a copy button so you can ask Claude to read it.

**Codex.** Codex has no prompt-injection hook. Once the conclusions are integrated the server tries `codex queue` once (10 s, best effort) with
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

## Known limitations

- Claude plan-mode plans (ExitPlanMode) are not captured; plans written to files are.
- Answers stream per message, not per token.
- Only the newest review unit of a session can take new questions; older ones become read-only history (threads
  still unsent or being answered at that point are marked expired).
- Codex: only `apply_patch` edits are detected as changed files, also when Codex applies the patch from code mode
  (read from the rollout's `FileChange` items). Files written by shell commands are found only by the end-of-turn
  scan (see above); add others with **+ Add file**. A Codex turn without a rollout path yields no files; deletions (and, in older rollouts without `FileChange` items, the source of a move) are shown as errors. `codex queue` into a running TUI is best effort.
- Codex forks fail with a clear error if `codex mcp list` cannot be read or an MCP server name is not a plain
  `[A-Za-z0-9_-]` key (it could not be disabled).
- Managed (policy) Claude settings outrank the fork's own settings; a managed `disableAllHooks` would turn the guard off.
- Images are served from the live file (binary files are not snapshotted).
- No CLI version check at startup.

## License

MIT. See [LICENSE](LICENSE).
