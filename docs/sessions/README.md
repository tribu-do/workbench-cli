# Workbench Sessions

The **session** lifecycle is the file-first entry point for turning planned requirements into a
running agent. A session gathers a set of REQ files, memory components, an agent, a runtime, a
port, and required secrets into a single draft record — then launches that record into a live
agent runtime on confirmation.

## Session Commands

| Command | Purpose |
|---------|---------|
| `create` | Scaffold a task-shaped prompt from REQs + memory |
| `start` | Launch a session in a runtime |
| `status` | Show session state |
| `list` | List sessions |
| `attach` | Attach to a running session |
| `stop` | Stop a session |
| `detach` | Detach from a session |
| `resume` | Resume a session |

Sessions are stored as file-first journal records under `.this/journals/`. A session id is a UUID keyed into the journal tree.

For the conceptual distinction between a **Session** (long-running runtime context) and a **Task**
(the primary user–agent unit), see the Mental Model in the [Workbench overview](../README.md). In
the file-first system, a session *is* a task-shaped journal record — there is no separate
`session.yaml`.

## The File-First Session Record

A session is a single journal record. There is no separate config file: every field — including
the chosen agent, runtime mode, port, and secret selections — lives in the YAML frontmatter of one
`journal.md`.

Records are stored under the **dated** journals tree, resolved by `resolveJournalsDir()`:

```
.workbench/memory/.this/journals/<YYYY_MM_DD>/<session-id>/
  journal.md    # YAML frontmatter (the SessionRecord) + a human-readable note
  prompt.md     # the scaffolded agent prompt
```

The date bucket (`YYYY_MM_DD`) is assigned at creation time. Lookups (`status`, `start`) locate a
record by globbing `journals/*/<session-id>/journal.md`, so the caller never needs to know the
date bucket — only the id.

### Record shape (`SessionRecord`)

The frontmatter persists these fields (see `tools/workbench/src/sessions/store.ts`):

| Field | Meaning |
|---|---|
| `session_id` | UUID allocated before any runtime setup begins. |
| `state` | `draft` (created, not launched) or `running`. |
| `created_at` / `updated_at` | ISO timestamps. |
| `req_sources` | Repo-relative REQ file paths that seed the prompt. |
| `agent` | Selected agent provider (`claude`, `codex`, `copilot`). |
| `user_preferences` / `agent_preferences` | Memory markdown files folded into the prompt. |
| `task_components` | Prior task journal records included as internal context. |
| `worktree` | `{ branch, path? }` for the git worktree. |
| `runtime` | `{ profile, mode }` — e.g. profile `bare-host`, mode `bare-host`. |
| `port` | Suggested/selected port. |
| `preview` | `{ enabled, target? }` preview-lane selection. |
| `secrets` | `SecretSelection[]` — each `{ key, scope, source }`, source `configured` (already in env) or `prompted`. |
| `prompt_path` | Path to `prompt.md`, relative to the `.this` root. |
| `runtime_state` | Set on start: `{ pid?, started_at? }`. |

The record is written by `workbench session`; the frontmatter is not meant to be hand-edited — use
`session start` / `session status` instead.

### The scaffolded prompt

`prompt.md` is built by `buildPromptBody()` as a pure concatenation of the selected REQ files and
selected memory/task components. It deliberately carries **no** runtime, agent, or port
information, so REQ files stay ignorant of how the session is executed. Runtime concerns are added
only at launch time (see below).

## Session Lifecycle

### `workbench session create`

Runs an interactive wizard (`runSessionCreateWizard`) and persists a **draft** record. No runtime
setup happens here at all — that is entirely `session start`'s job. The wizard performs only
read-only discovery (globbing REQ files, listing memory subtrees, reading `workbench.yaml`,
reading the port lease log, checking `process.env` for configured secrets) and collects, in order:

1. **REQ source** — one file, a hand-picked set, or a full domain's REQ set (discovered under
   `.scheme/**/REQs/req-*.md`).
2. **Agent** — from the enabled providers in `workbench.yaml`; an agent is shown as
   *configured* when all its required secrets are already present in the environment.
3. **User preferences** — markdown under `.this/user/`.
4. **Agent preferences** — markdown under `.this/agents/<agent>/`.
5. **Task components** — prior task journal records under `.this/journals/`.
6. **Worktree branch** — defaults to the current git branch.
7. **Runtime** — `bare-host` plus any profiles declared under `runtimes:` in `workbench.yaml`.
8. **Port** — suggested from the first free port in the configured range, read from
   `.workbench/leases.jsonl`.
9. **Preview** — optional; if enabled, a preview target is chosen.
10. **Secrets** — the agent's required keys; already-configured keys are recorded as `configured`,
    missing keys are prompted and recorded as `prompted`.

The session id is allocated (`allocateSessionId()`) before the record is written. On completion
the command prints the id and points at `workbench session start <id>`.

### `workbench session start <id>`

Confirms and launches a draft session in its selected runtime.

1. **Load credentials first.** `start` calls `loadCredentials()` before checking secrets, so keys
   configured on disk under `~/.workbench` (but not exported in the shell) reach `process.env` and
   are seen as present instead of being re-prompted — or hard-failing under `non_interactive`
   mode.
2. **Locate + guard.** The record is found by id; a session already in `running` state is
   rejected.
3. **Confirm.** A summary (REQs, agent, components, worktree, runtime, port, preview, paths) is
   shown for confirmation. Declining leaves the session in `draft`.
4. **Resolve secrets.** For each required key: use the env value if present; otherwise prompt (or
   fail in `non_interactive` mode).
5. **Launch** via `launchSessionRuntime()`, then rewrite the journal with `state: running` and the
   new `runtime_state` (`pid`, `started_at`).

### `workbench session status <id>`

Reads the journal record by id and prints its full recorded state — state, agent, REQ sources,
components, worktree, runtime, port, preview, paths, last update — plus a next-step hint
(`start` the session if still draft, or the running pid if launched). Read-only.

## Runtime Launch

`launchSessionRuntime()` (`tools/workbench/src/runtime/launch.ts`) performs the runtime setup and
agent execution for a session's persisted choice. Its contract:

- **Modes.** Only `bare-host` (host worktree + direct process) is implemented here. Any other
  runtime mode raises `RuntimeLaunchError('RUNTIME_MODE_NOT_IMPLEMENTED', …)`; those modes land
  with the runtime domain's own launch orchestration.
- **Agents.** Only `claude` is wired; other providers raise
  `RuntimeLaunchError('AGENT_NOT_IMPLEMENTED', …)`.
- **Steps.** Resolve the repo root, create the git worktree for the session branch, append a
  `reserved` port lease to `.workbench/leases.jsonl`, append a transparent-wrapper instruction to
  the scaffolded prompt, and launch the agent provider with the resolved secret values as env
  vars. Returns `{ sessionId, runtimeState: 'running', pid?, worktreePath, startedAt }`.

### Required secrets are single-sourced

The agent→required-secret map lives in exactly one place, `AGENT_REQUIRED_SECRETS`, with the
accessor `requiredSecretsFor(agent)`:

| Agent | Required secret |
|---|---|
| `claude` | `ANTHROPIC_API_KEY` |
| `codex` | `OPENAI_API_KEY` |
| `copilot` | `GITHUB_TOKEN` |

Both the create wizard (to mark an agent *configured* and to collect missing keys) and `session
start` (to resolve values before launch) read from `requiredSecretsFor()` rather than keeping their
own copies of the map.

## See Also

- [Workbench overview](../README.md) — the Session vs Task mental model.
- [Operations](../operations/README.md) — session/task engine and daemon.
- [Runtime](../runtime/README.md) — runtime modes and isolation.
- [Credentials](../credentials/README.md) — `~/.workbench.toml` configuration.
