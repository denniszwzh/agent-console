# Manual end-to-end verification: Claude Code

- Date: 2026-11-15
- Claude Code: 2.1.302, model claude-opus-5-5
- Platform: Windows 11, Node 22
- Method: the interactive TUI was NOT used. The "main session" was driven with
  `claude -p ... --output-format json --settings <hooks.json> [--resume <id>]` in a scratch git repo under `%TEMP%`.
  `hooks.json` contained only the two Agent Console hooks (Stop and UserPromptSubmit, absolute paths to `dist/hooks/*.js`).
  The server ran from `dist/server/main.js` with a temporary `AGENT_CONSOLE_HOME` and `port: 4398`, and the panel was
  driven through its REST API with the token (no browser). The real `~/.claude/` was never modified.
- Not covered here: browser rendering (mermaid diagram, warning banner, stale badge). Those need a visual pass.

## Step 1: install flow (against a COPY of settings.json)

Command: a scratch script copied `~/.claude/settings.json` to a temp dir and called the exported
`applyChange(copyPath, s => addHooks(s, hookCommands()), () => Promise.resolve(true))` from `dist/cli/main.js`.
`node dist/cli/main.js install` was not run against the real file.

Observed: the diff printed before/after hooks; a backup `settings.copy.json.agent-console-backup-<ts>` was created.
A JSON comparison of backup vs result showed: the only top-level key that changed is `hooks`; the only hook events
added are `Stop` and `UserPromptSubmit`; all five pre-existing hook events are identical. The temp copy was deleted.

Result: PASS

## Step 2: start the server

Command: `AGENT_CONSOLE_HOME=<tmp> node dist/server/main.js` (config port 4398).
Observed: `Agent Console running at http://127.0.0.1:4398/auth?token=...`. The browser auto-open of `node dist/cli/main.js`
was not exercised (it would open a window and use the default port/home).

Result: PASS (server start); browser auto-open not exercised

## Step 3: main turn creates a unit

Command (in the scratch repo): `claude -p "Write docs/test-spec.md ... mermaid flowchart ... 3-bullet summary" --output-format json --settings hooks.json --permission-mode acceptEdits`

Observed: session `98c0063a-...`. `GET /api/sessions` listed it; `GET /api/units?session=...` returned one unit with
`reply` (4 blocks) and one file source `docs/test-spec.md` (12 blocks, including a `code` block starting with
a mermaid fence). Mermaid rendering itself was not visually checked.

Result: PASS (data); visual rendering pending controller pass

## Step 4: parallel threads, child thread, isolation

Commands: `POST /api/units/:id/threads` twice (one anchored on the file's "flaky tests" bullet, one on the reply's Goals bullet),
then `POST /api/units/:id/send`. Later a child thread was added with `parentThreadId` on the first thread's assistant
message (anchor `sourceId: "msg:<messageId>"`) and sent.

Observed:
- Both threads went `answering` then `awaiting` within one 50 s wait (parallel); the child answered in about 30 s.
- Main transcript `~/.claude/projects/<proj>/98c0063a-....jsonl`: 40 lines and the same md5 before and after all fork runs.
- `GET /api/sessions` still listed only the main session after all forks (fork sessions did not create units): the fork Stop hooks were
  ignored (`isForkSession`, plus `AGENT_CONSOLE_FORK=1` in the hook scripts).
- Each fork has its own session id; the child fork built on its parent's answer.

Result: PASS

## Step 5: read-only enforcement and post-check

Commands (via `POST /api/threads/:id/messages`):
1. "Just edit docs/test-spec.md directly and change the 80% to 90%."
2. "Use any tool you can, including Bash or PowerShell, to create a file probe.txt ... containing the word hi."

Observed:
1. The fork replied that it is a read-only review branch and did not edit. File unchanged (still 80%).
2. The fork tried one PowerShell `Set-Content probe.txt` and the guard hook denied it. No `probe.txt` exists; `git status --porcelain` unchanged; `unit.warnings` empty.
3. Post-check, case A: a follow-up was sent, then `docs/test-spec.md` was appended to while the fork was answering. The file was
   untracked (its whole `docs/` dir was `?? docs/`). Result: NO warning. `git status --porcelain` prints just `?? docs/` before and after, so the diff is empty.
4. Post-check, case B: the file was committed first, then the same experiment. Result: `unit.warnings` gained
   `{threadId, paths:["docs/test-spec.md"]}` (status went from clean to ` M docs/test-spec.md`).

Result: PASS for the guard and for the warning on tracked files.
LIMITATION found here, since FIXED (fix round 1): the post-check used plain `git status --porcelain`, which collapses untracked directories and shows only status codes. It now uses `--untracked-files=all` and fingerprints each listed path (status + mtime + size), so edits inside untracked dirs and re-edits of already-modified files warn. Covered by unit tests; not re-run against the real CLI.

## Step 6: resolve, submit, deliver, stale

Commands: `POST /api/threads/:parent/resolve` (child still open), `POST /api/units/:id/submit` (threads open), then resolve child,
then both parents, then `POST /api/units/:id/submit`; then `claude -p "Apply the review conclusions." --resume <id> ...`.

Observed:
- Resolving the parent before its child: 409 `child threads must be resolved first`. Submit with open threads: 409.
- After resolving child then parents, each thread had a conclusion; submit returned a bundle with 2 numbered items (the child's
  conclusion is folded under its parent's). Unit status `submitted`, `delivered=false`.
- Next main `-p --resume` turn: the UserPromptSubmit hook injected the bundle (the bundle header appears in the main transcript), the agent edited
  `docs/test-spec.md` (80% to 90%, as the second conclusion requested), and `delivered` became `true`.
- The Stop hook created a new `open` unit for the new turn. The submitted unit stayed `submitted` (delivered); it did NOT become `stale`.
  The stale transition applies to units still `open`: after one more main turn, the previous open unit became `stale` and the
  newest was `open`. This is the intended behaviour (controller ruling): a submitted unit is already closed to writes, and only open units go stale.

Result: PASS (bundle delivered and applied)

## Step 7: server stopped

Commands: killed the server process (port 4398 no longer listening), then twice
`claude -p "Say OK only." --resume <id> --output-format json --settings hooks.json`.

Observed: both runs `is_error:false`, result `OK`, no hook error output; wall time 17.8 s and 17.6 s versus 16.8 s for the same turn with no
hooks at all (within noise). Hook scripts run directly with the server down: `claude-prompt` 235 ms, `claude-stop` 160 ms, both exit 0 with no output.
(A "no stdin data received" warning on stderr comes from the tool shell not providing stdin, not from the hooks.)

Result: PASS

## Fork isolation from user-level hooks and plugins (--setting-sources)

Problem: the user's globally enabled "remember" plugin ran its SessionStart hook inside a fork and created `.remember/` in the fork's cwd.

Experiment (fork argv as in `buildClaudeArgs`, with and without the new flag, `AGENT_CONSOLE_FORK=1`):
- Default: the stream showed `SessionStart:fork` hook events and `.remember/` appeared in the scratch repo.
- With `--setting-sources project,local`: no hook events, no `.remember/`, only built-in plugins loaded, the fork authenticated and answered ("hello"),
  `is_error:false`.
- With the flag, a fork asked to run `Set-Content probe2.txt hi` through PowerShell: our `--settings` guard hook still denied it
  (`permission_denials` listed the call), no file created. So the guard still applies.

Decision: ADOPTED. `src/agents/claude.ts` `buildClaudeArgs` appends `--setting-sources project,local`; the exact-argv test and a focused test were updated
(RED first: both failed, then GREEN). Full suite: 408 passed.

Side note: with `--output-format stream-json --verbose` the `result` line is followed by a trailing `system:task_summary` line, so "the last line is the
result" is not exact; `parseClaudeStream` returns at `result`, so it is unaffected.
