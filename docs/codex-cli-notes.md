# Codex CLI capability notes (spike for the Codex adapter)

Tested with `codex-cli 0.167.0` on Windows 11, in a scratch git repo under `%TEMP%`.
Every call used `-s read-only` (set on the `exec` command, see below). Prompts were tiny.
Fixtures sit in `tests/fixtures/` (paths and account ids sanitised: `<SCRATCH>`, `<HOME>`, `user`).

Status legend: VERIFIED = observed live. DOCS = taken from the official docs / generated schemas
(https://learn.chatgpt.com/docs/hooks and `openai/codex` `codex-rs/hooks/schema/generated`) and NOT observed live.

## Summary for the adapter (answers to the five questions)

1. Turn-end hook event: `Stop` (DOCS, not captured live, see "Hooks"). Stdin JSON keys:
   `session_id`, `transcript_path` (string or null), `cwd`, `hook_event_name`, `model`, `permission_mode`,
   `turn_id`, `stop_hook_active`, `last_assistant_message` (string or null). Same shape as Claude's Stop input,
   plus `turn_id`, `model`, `permission_mode`. Stdout MUST be JSON (e.g. `{}`) when exit code is 0; plain text is invalid for Stop.
2. Last reply text: the Stop hook's `last_assistant_message`; or `-o/--output-last-message <file>`;
   or in `--json` the last `item.completed` with `item.type == "agent_message"` (`item.text`);
   or in the rollout the `event_msg` `task_complete` record, `payload.last_agent_message`.
3. Files changed in a turn: parse the rollout file (`transcript_path`). Edits are `response_item` records with
   `payload.type == "custom_tool_call"`, `payload.name == "apply_patch"`, `payload.input` = patch text with
   `*** Add File: / *** Update File: / *** Delete File: / *** Move to:` headers. Shell edits are NOT structured
   (they appear as shell tool calls). Details below. Alternative for the Stop hook: diff `git status --porcelain` before/after.
4. Stream events to `AgentEvent`: see the mapping table below.
5. `codex queue`: usable as a message mailbox, delivered at the next turn of that thread (VERIFIED with `codex exec resume`).
   Live injection into a running TUI session could NOT be verified (no TUI available). See "codex queue".

## Step 1: `codex exec --json`

Command (prompt from stdin; with a prompt argument and an open stdin, Codex prints "Reading additional input from stdin..." on stderr, so pass `-`):

```
echo "Reply with exactly: hi" | codex exec -s read-only --json - > codex-exec.jsonl
```

(The very first call was `codex exec --json -s read-only "Reply with exactly: hi"`; the fixture is from that call.)

stdout is pure JSONL, one event per line (`tests/fixtures/codex-exec.jsonl`):

```
{"type":"thread.started","thread_id":"01a1dd95-2d4f-7b60-99eb-5e63136a8137"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"hi"}}
{"type":"turn.completed","usage":{"input_tokens":17944,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":9,"reasoning_output_tokens":0}}
```

- Session / thread id: `thread.started` -> `thread_id` (first line). It equals the rollout `session_meta.payload.id` and the
  `session_id` hook field (DOCS for the hook; the rollout filename ends with the same UUID, VERIFIED).
- Event types seen: `thread.started`, `turn.started`, `item.started`, `item.completed`, `turn.completed`.
  Item types seen: `agent_message` (`text`), `command_execution` (`command`, `aggregated_output`, `exit_code`, `status`: `in_progress` then `completed`).
- stderr carries log noise (e.g. `ERROR codex_api::endpoint::responses_websocket: failed to connect to Responses WebSocket`). It did not
  stop the run (exit 0, it falls back to HTTP). The adapter must not treat stderr text as failure; use exit code + events.
- A turn can contain several `agent_message` items: in the rollout the earlier ones have `phase: "commentary"` and the last has
  `phase: "final_answer"` (`--json` drops the phase). Example: `tests/fixtures/codex-exec-apply-patch-blocked.jsonl`
  (first message is narration, second is the answer). Use the LAST `agent_message` before `turn.completed` as `finalText`.
- Shell tool shows up as `command_execution` (`tests/fixtures/codex-exec-shell.jsonl`); `command` is the full pwsh command line.
  `apply_patch` does NOT produce any `--json` item (even when rejected), so file edits are invisible in the event stream.
- Error shape was not triggered. Not-observed error events: treat non-zero exit, a `turn.failed`/`error` event (name unverified), or
  missing `turn.completed` as `{type:'error'}`.

## Step 2: fork and resume

Important CLI quirk: `codex exec fork` and `codex exec resume` do NOT accept `-s/--sandbox` themselves
(`error: unexpected argument '-s' found`). The sandbox flag must go on `exec`, before the subcommand.
`--json` and `-c` work in both positions. Working commands:

```
echo "What did you reply?" | codex exec -s read-only --json fork <PARENT_ID> - > codex-fork.jsonl
codex exec -s read-only --json resume <PARENT_ID> "Did you receive any queued message? Quote it, or say none." > codex-resume.jsonl
```

Fork output (`tests/fixtures/codex-fork.jsonl`):

```
{"type":"thread.started","thread_id":"01a1dd95-f8c5-7380-8dde-9aff6533a935"}      <- NEW id
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I replied: hi"}}
{"type":"turn.completed","usage":{...}}
```

Checks:
- New id differs from the original: YES (`...2d4f...` vs `...f8c5...`), and it is already in the first line.
- Original session untouched: YES. After the fork the original rollout still had its 16 lines and the same mtime
  (13:01). The fork wrote its own rollout whose `session_meta` has `forked_from_id` = parent id, `forked_from_ordinal_exclusive: 16`
  and a `history_base` pointer (it references the parent history instead of copying it).
- Fork inherits context: it answered "I replied: hi".
- The fork's `turn_context.sandbox_policy` is `{"type":"read-only"}` (sandbox set on the exec command carries to the fork).
- `codex exec resume <id>` is NOT a fork: it reuses the same id (`thread.started.thread_id` equals the parent id) and appends to the
  parent rollout (28 lines after resume, was 16 + 12). Never use resume for read-only side questions.
- `--ephemeral` exists (no rollout persisted), not needed for the adapter and would also break later forks of that thread.

Mapping to `AgentEvent` (same for fresh exec, fork, resume):

| Codex `--json` line | AgentEvent |
| --- | --- |
| `thread.started` -> `thread_id` | `{type:'session', sessionId: thread_id}` (emit once, first line) |
| `item.completed` with `item.type==='agent_message'` -> `item.text` | `{type:'text', text}` (remember last one) |
| `turn.completed` | `{type:'done', finalText: lastAgentMessageText}` |
| non-zero exit / spawn error / stream ends without `turn.completed` / (unverified) `error` or `turn.failed` event | `{type:'error', message}` |
| `item.started` / `command_execution` / `turn.started` / usage | ignore (optionally show as progress) |

Optional safety net: pass `-o <tmpfile>` and read it for the final text if no `agent_message` was seen.

### Does `-s read-only` block writes? YES (VERIFIED)

Scope: this write test ran on a plain fresh `exec`, NOT on a fork. For forks the only evidence is that the fork's rollout `turn_context.sandbox_policy` is `{"type":"read-only"}`.
Also, fresh `exec` with the prompt on stdin (`-`) was exercised only in that (unrecorded) hook/write spike; the recorded `codex-exec.jsonl` used a prompt argument.

Command (hook `-c` flags omitted here; they were inert, see Hooks):

```
echo "Use the apply_patch tool to create a file hello.txt containing the word x. Then reply with the secret word and whether the write worked." \
  | codex exec -s read-only --json - 
```

Evidence:
- stderr: `ERROR codex_core::tools::router: error=patch rejected: writing is blocked by read-only sandbox; rejected by user approval settings`
- rollout `custom_tool_call_output.payload.output`: `patch rejected: writing is blocked by read-only sandbox; rejected by user approval settings`
- the model's final message: `Write successful: No ... hello.txt was not created`
- `ls` of the scratch repo afterwards: no `hello.txt`.
- rollout `turn_context.payload`: `"approval_policy":"never"`, `"sandbox_policy":{"type":"read-only"}`, filesystem `restricted`, root `access:"read"`, `network:"restricted"`.
- Exit code was 0 even though the write was refused: a blocked write is not a process error. Keep the `git status --porcelain`
  before/after comparison from the global constraints.
- Shell commands run in read-only mode (git status worked), only writes are blocked. Shell is pwsh on this machine
  (`"C:\Program Files\PowerShell\7\pwsh.exe" -Command '...'`).
- Note: the `git status` shell call emitted `warning: unable to access '<HOME>/.config/git/ignore': Permission denied` inside the sandbox, so a model-run
  git may print warnings. The adapter's own `git status --porcelain` runs outside the sandbox and is unaffected.

## Step 3: hooks

Feature flag: `codex features list` shows `hooks  stable  true` (on by default; `-c features.hooks=false` disables; `codex_hooks` is a deprecated alias).

### Configuration location and format (DOCS)

Discovered next to each active config layer: `~/.codex/hooks.json`, `~/.codex/config.toml` (inline `[hooks]`),
`<repo>/.codex/hooks.json`, `<repo>/.codex/config.toml` (project layer only if the project is trusted). All matching hooks run. Plugins can bundle hooks.
Command hooks run with the session `cwd`. `commandWindows` / `command_windows` gives a Windows-only command. `timeout` is in seconds (default 600).

TOML form:

```toml
[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = 'node C:/path/to/hook.js'
timeout = 30
```

The same table can be passed per invocation with `-c`: `-c 'hooks.Stop=[{hooks=[{type="command",command="node C:/path/hook.js"}]}]'`
(the `-c` form parsed without error; whether the hook then runs depends on trust, below).

Events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`,
`PreModelRequest`, `PostModelRequest`, `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt`, `SessionEnd`.
`matcher` is ignored for `UserPromptSubmit`, `Stop`, `Interrupt`. For `apply_patch` PreToolUse/PostToolUse, matcher can be `apply_patch`, `Edit` or `Write`.

### Hook trust (symptom VERIFIED, cause DOCS/inferred)

Non-managed hooks must be reviewed/trusted before they run. Trust is stored per hook as a hash in the user's config
(`[hooks.state."<config path>:<event>:<i>:<j>"] trusted_hash = "sha256:..."`) and is granted through `/hooks` in the interactive TUI.
Observation (symptom only): I ran `codex exec -s read-only --json -c 'hooks.SessionStart=...' -c 'hooks.PreToolUse=...' -c 'hooks.PostToolUse=...' -c 'hooks.UserPromptSubmit=...' -c 'hooks.Stop=...' -`
with a Node script that writes its stdin to a file. The run succeeded but NO hook file was written and there was no warning on stderr or in `--json`:
hooks passed this way did not fire in `exec` mode, silently. That missing trust is the cause is INFERRED from the docs; there was no control run
(for example a hook defined in a file and already trusted). The alternative explanation, that the `-c hooks.<Event>=[...]` form is simply not honoured by `exec`,
is equally consistent with what was observed and was not ruled out. The documented non-interactive override is `--dangerously-bypass-hook-trust`
(documented, "for automation that already vets hook sources"); the environment's permission layer refused that flag for this spike, and writing a trust hash needs
a change to `~/.codex/config.toml` (forbidden), so no hook input could be captured live.

Consequences for the adapter / installer:
- A Codex hook for the panel needs the user to trust it once (`/hooks` in the TUI) after the installer writes it. The installer docs must say so, and the status check
  should treat "hook installed but untrusted" as not working (it will silently never fire).
- Changing the hook command changes its hash, so it must be re-trusted. Keep the command string stable (point at a fixed script and put logic in the script).
- Hooks should NOT be needed for the forked question threads (they run with `AGENT_CONSOLE_FORK=1`); keep the same fork guard as Claude if hooks are active.

### Stdin JSON (DOCS; fixtures are doc/schema-derived, not captured)

Every command hook gets exactly one JSON object on stdin. Common keys: `session_id`, `transcript_path` (string|null), `cwd`, `hook_event_name`,
`model`, `permission_mode` (`default|acceptEdits|plan|dontAsk|bypassPermissions`). Turn-scoped events add `turn_id`.

- `Stop` (`tests/fixtures/codex-hook-stop.docs.json`): + `turn_id`, `stop_hook_active`, `last_assistant_message`. All of these are required by the schema.
- `UserPromptSubmit` (`tests/fixtures/codex-hook-user-prompt-submit.docs.json`): + `turn_id`, `prompt`; optional `agent_id`, `agent_type`.
- `PostToolUse` / `PreToolUse`: + `turn_id`, `tool_name` (`Bash`, `apply_patch`, `mcp__server__tool`, ...), `tool_use_id`, `tool_input`
  (`tool_input.command` for Bash and apply_patch; for apply_patch that is the patch text), PostToolUse also `tool_response`.
- `SessionStart`: + `source` = `startup|resume|clear|compact|fork`.

These `.docs.json` fixtures carry a `"_source"` key saying they are not live captures (ignore that key when parsing). They were written from the published schema; the values (ids, prompt, message) are real ones from this spike's first run, the
path fields use placeholders. Re-capture them with a trusted hook when convenient and diff against the files.

The answer to "does the input contain session id and the rollout path": yes, `session_id` and `transcript_path`. The docs warn that the
transcript format "is not a stable interface"; `transcript_path` can be null, so fall back to globbing (see rollout section).

### Hook output semantics (DOCS)

- `UserPromptSubmit` CAN inject context: plain text on stdout (exit 0) is added as extra developer context, or JSON
  `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"..."}}`. It CAN block:
  `{"decision":"block","reason":"..."}` or exit code 2 with the reason on stderr. Common fields (`continue`, `stopReason`, `systemMessage`) also apply.
  (Unlike Stop, plain text is allowed here.) The model-visible hook output is capped at about 2500 tokens by default (`additionalContextLimit`).
- `Stop`: stdout must be JSON on exit 0 (print `{}`); plain text is invalid. `{"decision":"block","reason":"..."}` or exit 2 does NOT reject the turn,
  it makes Codex continue with `reason` as a new prompt. A pure observer hook (like the panel's) must print `{}` and exit 0 and must never block.
- `PreToolUse`: plain stdout ignored; `permissionDecision: "deny"` (or `decision:"block"`, or exit 2) blocks; `allow` + `updatedInput` rewrites.
- Hooks can be `async: true` (background, cannot block).

My test hook printed `The secret word is PINEAPPLE...` for UserPromptSubmit; because hooks never ran (trust) the model did not see it
(it answered the secret word as "x", taken from my prompt), so the injection behaviour itself is NOT verified live.

## Rollout / session files (VERIFIED)

- Location: `~/.codex/sessions/YYYY/MM/DD/rollout-<local time YYYY-MM-DDTHH-MM-SS>-<thread id>.jsonl` (directory date is local date).
  Example: `~/.codex/sessions/2026/11/15/rollout-2026-11-15T13-01-43-01a1dd95-2d4f-7b60-99eb-5e63136a8137.jsonl`.
  Resolve a rollout from a session id by globbing `sessions/*/*/*/rollout-*-<id>.jsonl`. `CODEX_HOME` overrides `~/.codex`.
  Other state in `~/.codex`: `session_index.jsonl`, `state_5.sqlite`, `queue_1.sqlite`, `thread_history_1.sqlite`.
- `tests/fixtures/codex-rollout-apply-patch-blocked.jsonl` is a TRIMMED excerpt of one rollout, not a full file. Dropped: `additional_tools`, developer-role and `environment_context`
  messages, `world_state`, `thread_settings_applied`, `token_usage_record` / `token_count`; `session_meta` lost `creator_user_id`, `creator_account_id`, `base_instructions`;
  `turn_context` is reduced to turn_id/cwd/approval_policy/sandbox_policy/permission_profile/model. Kept: `task_started`, user message, `custom_tool_call`, `custom_tool_call_output`, `AgentMessage` items, `task_complete`.
- One JSON object per line: `{"timestamp", "ordinal", "type", "payload"}`. Top-level `type` values: `session_meta` (first line:
  `id`, `session_id`, `cwd`, `cli_version`, `source`, `git`, `forked_from_id` for forks, plus large `base_instructions`; also account ids, sanitise before sharing),
  `turn_context` (`cwd`, `approval_policy`, `sandbox_policy`, `permission_profile`, `model`), `event_msg`, `response_item`, `world_state`, `token_usage_record`.
- `event_msg.payload.type`: `task_started` (carries `turn_id`, `turn_attribution.turn_trigger`: `exec` or `queue`), `item_completed`
  (`item.type` `UserMessage` / `AgentMessage` with `phase` `commentary|final_answer`), `thread_settings_applied`, `token_count`,
  `task_complete` (`last_agent_message` = final text, `turn_id`, `duration_ms`).
- Turn boundary: lines between a `task_started` and the matching `task_complete` (same `turn_id`) are one turn.
  A sidebar "this turn changed files" scan should read from the last `task_started` to the end.
- File edits (`tests/fixtures/codex-rollout-apply-patch-blocked.jsonl`):

```
{"type":"response_item","payload":{"type":"custom_tool_call","status":"completed","call_id":"call_...","name":"apply_patch",
  "input":"*** Begin Patch\n*** Add File: hello.txt\n+x\n*** End Patch"}}
{"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call_...",
  "output":"patch rejected: writing is blocked by read-only sandbox; rejected by user approval settings"}}
```

  Patch grammar: `*** Add File: <path>`, `*** Update File: <path>` (optionally followed by `*** Move to: <path>`), `*** Delete File: <path>`, then `@@` hunks.
  Paths are relative to the turn's `cwd`. `findChangedFilesCodex` should: take `custom_tool_call` records with `name == "apply_patch"` of the last turn,
  regex `^\*\*\* (Add|Update|Delete) File: (.+)$` (and `Move to`), and only count calls whose matching `custom_tool_call_output` (same `call_id`) is not a rejection.
  Success output text and any `patch_apply_end`-style event were NOT observed because writes were forbidden in this spike (UNVERIFIED);
  the safe rule is "no `rejected`/`failed` text in the output".
- Shell: function calls (`exec_command`) with an `arguments` JSON string, not parsed for file changes; files changed by shell commands (redirects, `sed -i`,
  `git checkout`) are not recorded structurally. If the adapter needs them, combine with the `git status --porcelain` diff (Task 6 already does this).
- Forks: separate rollout with `forked_from_id`; its history references the parent via `history_base`, so a fork's own rollout contains only
  the post-fork lines (12 lines here). For changed-file detection of a fork run read the fork's own rollout.

## Step 4: `codex queue` (PARTIAL)

```
codex queue --thread <ID> --message "QUEUED-PING: reply with exactly: queued-ok"
-> Queued message 01a1dd99-211d-70f0-8c54-78c3d049ca59 for thread 01a1dd95-2d4f-7b60-99eb-5e63136a8137.   (exit 0)
codex exec -s read-only --json resume <ID> "Did you receive any queued message? Quote it, or say none."
-> agent_message: "QUEUED-PING: reply with exactly: queued-ok"      (fixtures/codex-resume.jsonl)
```

Observed in the rollout: the resumed turn has `task_started.turn_attribution.turn_trigger == "queue"`, and the queued text is
recorded as a `role:user` message BEFORE my resume prompt, with an extra `client_id` on its `UserMessage` item. So the queued message is stored in
`~/.codex/queue_1.sqlite` and delivered as a user message at the start of the next turn of that thread, including by `codex exec resume`.
(The queued turn did not run on its own: `codex queue` without `--resume` only enqueues; the model saw the text because the next turn drained the queue.)
Flags: `--thread` = session UUID or exact session name, `--message`, `--resume` (after queueing, try to resume the thread on the local daemon/remote
app-server; a failed resume only warns), `--remote`, `-p/--profile`, `-c`.

NOT verified: delivery into a currently running interactive TUI session (none available). `--resume` talks to a local app-server daemon; I did not use it
(it could start work in the user's real environment). Conclusion for the adapter: `codex queue` is a usable "send a message to this thread" primitive for
a thread that is idle; for a live terminal session do not rely on it without a manual test, and the panel's "inject into main terminal" feature should
fall back to the clipboard/paste approach (or be labelled best-effort) for Codex.

## Open items / not verified

- Hook stdin capture and `UserPromptSubmit` context injection: need a trusted hook (TUI `/hooks` or `--dangerously-bypass-hook-trust`, the latter was refused here).
- Error events in `--json` (auth failure, rate limit): not triggered.
- Successful `apply_patch` records (only the rejected form was observed; writes were forbidden).
- `codex queue` into a live TUI.
- Prompt via stdin plus `fork`/`resume`: works with `-` as the prompt (verified for fork). The fork prompt is mandatory ("fork requires a prompt" per `--help`).
