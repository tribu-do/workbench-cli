# Workbench Architecture

## Mental Model

Workbench is organized as a four-level hierarchy:

| Level | Concept | Description |
|---|---|---|
| 1 | **Workbench** | The full system: daemon, CLI, runtime, and all configured workspaces. |
| 2 | **Workspace** | A single project or repository (`workbench.yaml` + `.workbench/`). |
| 3 | **Session** | A long-running runtime context within a workspace. Survives disconnects (tmux-like). |
| 4 | **Task** | The primary user-agent interaction unit. Each task gets its own branch, worktree, sandbox, ports, secrets, and optionally a preview deployment. |

## Five Pillars

1. **Unified memory** — Hierarchical, agent-accessible context storage. OpenViking as the source-of-truth layer; LanceDB for semantic/vector augmentation.
2. **Sandboxed runtime sessions** — Isolated execution with AIO Sandbox as the target mediation layer; devcontainers as the baseline.
3. **Skills and MCP management** — Project-scoped reusable modules installed into agent config paths (Claude `~/.claude/commands/`, Codex `~/.codex/skills/`).
4. **Re-attachable sessions** — Long-running sessions that survive client disconnects and allow detach/reattach.
5. **Preview lanes** — Automated deployment previews via Coolify (full-stack), Netlify (static), and Cloudflare (edge).

## Configuration: Installation Manifest

A workspace is anchored by a single **`workbench.yaml`** manifest at the project root. `config.ts` (`tools/workbench/src/config.ts`) owns loading, merging, and writing it:

| Function | Behavior |
|---|---|
| `findConfigPath(startDir?)` | Walks upward from the start directory (default `cwd`) to find the nearest `workbench.yaml`; returns `null` if none exists. |
| `loadConfig(configPath?)` | Reads and parses the manifest, then merges it over `DEFAULT_CONFIG`. Returns `DEFAULT_CONFIG` when no file is found. |
| `writeConfig(config, configPath?)` | Serializes the config back to YAML (2-space indent). |
| `mergeConfig(defaults, overrides)` | Field-by-field merge; **explicitly enumerates every key**, so a new config member must be added here or `loadConfig` silently drops it. |

`WorkbenchConfig` (defined in `src/types.ts`) is the manifest shape. Notable members carried by `DEFAULT_CONFIG`:

- `workspace` — `{ id, name }`; `init` assigns an 8-char UUID slice as `id`.
- `runtime.mode` — legacy runtime mode (`daemon-managed` default); still read by `task.ts`/`orchestrator.ts`.
- `runtimes` / `default_runtime` — per-profile runtime registry (owned by the runtime domain). `DEFAULT_CONFIG` always ships the `bare-host` profile and points `default_runtime` at it.
- `preview` — default provider, rules, and GC policy.
- `ports` — port-allocator range/strategy.
- `secrets`, `agents.providers`, `diagrams`.
- `memory` — the **memory context-store selector** (`{ plugin?: string }`); architecture is its type authority.

### Global directory and credentials (`~/.workbench`)

User-level state lives in a single TOML file:

| Resolver | Path | Purpose |
|---|---|---|
| `resolveGlobalConfigPath()` | `~/.workbench.toml` | Global config (credentials, settings) in TOML format, mode `0600`. |

`loadCredentials()` parses the TOML file and maps sections to `process.env` (without overwriting already-set vars):
- `[agents]` → `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `WORKBENCH_OLLAMA_URL`
- `[memory]` → `WORKBENCH_MEMORY_BACKEND`, `WORKBENCH_OPENVIKING_*`
- `[deployments.*]` → `WORKBENCH_COOLIFY_*`, `WORKBENCH_NETLIFY_*`, `WORKBENCH_CLOUDFLARE_*`

`loadGlobalConfig()` / `writeGlobalConfig()` round-trip the TOML file. The docs embedding preset helpers (`defaultEmbeddingModelFor`, `defaultApiBaseFor`, `resolveEmbeddingPreset`) resolve `openai` / `ollama` / `lm-studio` presets into the `DOCS_MCP_EMBEDDING_MODEL` + `OPENAI_API_BASE` pair consumed by `@arabold/docs-mcp-server`.

## File-First Workspace Store

Per-workspace state is a plain-file tree under **`.workbench/`**. `config.ts` is the single path authority; every command imports these resolvers rather than hard-coding paths. Each resolver honors an environment-variable override (shown where relevant).

```
.workbench/                              resolveWorkbenchDir()  (WORKBENCH_DIR)
├── previews.jsonl                       resolvePreviewsLog()   — append-only preview-deploy events
├── leases.jsonl                         resolveLeasesLog()     — append-only port-lease events
├── audit.jsonl                          resolveAuditLog()      — append-only audit events
├── secrets/                             resolveSecretsDir()    — scoped secret manifests
├── runtimes/                            resolveRuntimesDir()   — per-profile runtime tree
│   ├── <mode>/<profile>.yaml            resolveRuntimeProfileSettingsPath(mode, profile)
│   └── logs/<mode>.jsonl                resolveRuntimesLogsDir() / resolveRuntimeLogPath(mode)
└── memory/                              resolveMemoryRoot()    (WORKBENCH_MEMORY_ROOT)
    ├── openviking/                      resolveOpenVikingWorkspace()
    └── .this/                           resolveMemoryThisDir() — file-first local memory root
        ├── journals/                    resolveJournalsDir()   — canonical task/session store of record
        │   └── <YYYY_MM_DD>/<task-id>/  dated record per task
        └── resources/docs/             resolveDocsMcpDataDir() — docs-mcp-server knowledge base
```

Key points:

- **Task/session store of record** is the dated `journals/<YYYY_MM_DD>/<task-id>/` tree under `.this/`, not a database. `resolveJournalsDir()` returns its root. The retired `.workbench/sessions/` directory no longer exists.
- **Docs knowledge base** lives *inside* the local memory tree at `resources/docs`. `resolveDocsMcpDataDir()` is defined here only; `docs.ts` imports it, so the docs server inherits the path automatically.
- **Append-only logs** (`previews.jsonl`, `leases.jsonl`, `audit.jsonl`) store operational events; JSON-Lines records are appended, not mutated.

## CLI Architecture

### Entry point

The real executable is **`tools/workbench/bin/cli.ts`** (`#!/usr/bin/env node`). It does one thing: `createProgram().parse()`. `createProgram()` in `src/cli/index.ts` builds the Commander program, registers every command, and wires the root action.

The program declares a global `--no-interactive` flag; a `preAction` hook maps Commander's `opts().interactive === false` into `ui.setNonInteractive(...)` so all downstream prompts switch to non-interactive behavior.

### The UX layer (`src/cli/ui.ts`)

All user-facing output flows through `src/cli/ui.ts`, a thin dual-mode wrapper over [`@clack/prompts`](https://www.npmjs.com/package/@clack/prompts) and `picocolors`. It exists so every command behaves correctly whether a human is at a TTY or an agent/pipe is driving it.

`mode()` returns `interactive` or `non_interactive`. It is `non_interactive` when `--no-interactive` was set, when `WORKBENCH_NO_INTERACTIVE=1`, or when stdout/stdin are not both TTYs. This is the pivot every helper branches on:

| Helper | Interactive | Non-interactive |
|---|---|---|
| `intro(desc)` / `outro(msg, next?)` | Colored banner + clack intro/outro; `outro` shows a "Next steps" note | Plain banner + printed lines |
| `spin(label, fn)` | clack spinner around the async `fn`; `— done` / `— failed` | Prints `label...` then runs `fn` |
| `select` / `multiselect` | clack menu; disabled options render with a green `✓ (configured)` tag and re-prompt if picked | Returns the provided `default`, else throws `NonInteractiveError` |
| `text` / `password` / `confirm` | clack field with optional `validate` | Returns `default`, else throws `NonInteractiveError` |
| `commandMenu` | Arrow-key palette (`maxItems: 12`) | Prints a static `value  hint` list, returns `null` |
| `note(msg, title?)` | Boxed clack note | `title:` line + message |
| `log.info/success/warn/error/step` | clack log styles | `console.log/warn/error` |
| `group(steps)` | clack wizard; cancel rolls back and exits `130` | (used by init; steps run in order) |

Design contracts worth noting:

- **Fail-fast, never hang.** A prompt with no `default` throws `NonInteractiveError` in non-interactive mode instead of blocking on stdin — agents get an actionable error rather than a hang.
- **Cancellation is uniform.** `unwrap()` intercepts a Ctrl-C (`isCancel`) from any clack prompt and exits `130` with a "Cancelled." message; `group()` rolls back with "no changes written."
- **Disabled options are first-class.** clack has no native disabled state, so `select`/`multiselect` decorate configured entries and re-prompt (or filter) when one is chosen.

### Root command UX (`src/cli/index.ts`)

Running `workbench` with no subcommand invokes `runRoot()`, which is **state-aware**. `detectWorkspaceState()` reads the filesystem (file-first — no DB):

| State | Condition | Behavior |
|---|---|---|
| `uninitialized` | no `workbench.yaml` found | note: "Type /init to get started" |
| `partial` | manifest present, `.workbench/` tree absent | note: "Run /doctor to see what needs attention" |
| `ready` | manifest + `.workbench/` tree present | boxed command palette, then an arrow-key `commandMenu` |

The palette is built from the live Commander command list (`commandOptions`), so it stays in sync with whatever commands are registered. `status` (registered inline in `index.ts`) wraps its reads in `ui.spin` and reports workspace, runtime, preview, task, and port summaries via `ui.log.info`.

### `workbench init` — pillar wizards (`src/cli/commands/init.ts`)

`init` is a command group whose default subcommand (`init workspace`) is a `ui.group` wizard, plus focused per-pillar subcommands:

| Subcommand | Purpose |
|---|---|
| `init workspace` *(default)* | Scaffolds the `.workbench/` state tree, writes `workbench.yaml`, ensures the credentials file, warms the docs-server npx cache, and optionally adds `.workbench/` to `.gitignore`. Ends by offering the other pillars as "next steps". |
| `init memory` | Configures the memory context store (OpenViking embedded vs. client-docker). |
| `init sandboxing` | Configures a runtime profile; renders `RUNTIME_MENU`, runs the mode's host-prerequisite probe, and writes the profile (e.g. `bare-host`, `docker-compose`). |
| `init agent` | Stores AI-agent credentials (claude/codex/copilot API keys, or a local Ollama URL for opencode). |
| `init deployment` | Stores a preview provider token (coolify/netlify/cloudflare). |
| `init docs` | Selects the docs embedding preset and persists it to the global config. |

`scaffoldWorkspace()` creates the tree via the resolvers (`resolveMemoryThisDir`, `resolveJournalsDir`, `resolveDocsMcpDataDir`, `resolveSecretsDir`, `resolveRuntimesDir`, `resolveRuntimesLogsDir`). Credentials are written through `setCredential()`, which updates `~/.workbench.toml` at mode `0600`. `configuredDomains()` inspects env vars so already-configured pillars render disabled in the wizard.

### Command UX patterns

Every command follows the same shape, so behavior is uniform:

1. **`intro`** at the top for the banner/title.
2. **`ui.spin`** around any blocking work (health checks, deploys, docs-server calls, status reads).
3. **`ui.log.*`** / **`ui.note`** for results; **`ui.outro`** with next steps at the end.
4. **Optional positionals prompt interactively.** Where a value used to be a required positional (`secret set/rotate <key> [value]`, `docs search <library> [query]`), the value is now optional: interactive mode prompts (via `ui.password` / `ui.text`), non-interactive mode emits `ui.log.error` and exits `1`.
5. **Structural identifiers stay required.** Arguments that are identities (e.g. `deploy preview <taskId>`) keep Commander's required-argument enforcement; commands add `ui.log.error` for not-found lookups.

The append-only `deploy preview` path records deployments to `.workbench/previews.jsonl` (via `resolvePreviewsLog()`).

## Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Workspace store | File-first `.workbench/` tree | Plain files (dated journals + JSONL logs) are inspectable, diff-able, and infra-free. |
| Task/session record | Dated `journals/<YYYY_MM_DD>/<task-id>/` | Human-readable store of record under the local memory tree. |
| Memory orchestration | OpenViking + LanceDB | Hierarchical file-system-like model fits the scope cascade; LanceDB adds semantic retrieval. |
| Sandbox baseline | Runtime profiles (`bare-host` default; `docker-compose`, devcontainers/AIO planned) | Per-profile registry with host-prerequisite probes gates configuration. |
| Primary PaaS | Coolify (self-hosted) | Predictable cost; API-driven automation. |
| Frontend previews | Netlify + Cloudflare | Fast showcase loop; shared provider interface. |
| CLI UX | `@clack/prompts` + `picocolors`, dual-mode | Native interactive fields for humans; fail-fast `NonInteractiveError` for agents/CI. |

## Design Principles

1. DX first — every design decision is evaluated against developer experience.
2. Isolation by default — branches, worktrees, and containers enforce task boundaries.
3. Scope cascade — task-local always wins; global is the fallback.
4. File-first state — durable state is inspectable plain files, not an opaque database.
5. Dual-mode by construction — every UX helper works identically for a human at a TTY and an agent driving a pipe.
6. Single path authority — `config.ts` resolvers are the only definition of every workspace path.

## See Also

- [Usage](../usage/README.md) — install, quick start, CLI reference, configuration.
- [Runtime](../runtime/README.md) — runtime modes, profiles, sandbox boundaries.
- [Memory](../memory/README.md) — memory subsystem, OpenViking + LanceDB.
- [Operations](../operations/README.md) — daemon lifecycle, `.workbench/` directory structure.
