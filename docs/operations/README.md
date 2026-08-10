# Workbench Operations

## Workspace Initialization

```bash
workbench init --name my-project --mode daemon-managed --provider coolify
```

Creates:
- `workbench.yaml` — workspace configuration at the project root
- `.workbench/` — local data directory (auto-added to `.gitignore`)

## `.workbench/` Directory Structure

The local data directory is organized by pillar:

```
.workbench/
  memory/               # Hierarchical memory (file-first)
    docs/
      indexed/
    openviking/
  runtimes/             # Runtime instance data
    devcontainers/
    aio/
    openshell/
  llms/                 # Agent and skill data
    agents/
      coding/
        claude/
        codex/
        copilot/
      skills/
      mcps/
  profiles/             # Saved workspace configurations
    agile/
```

## Daemon Lifecycle

Workbench runs a background daemon (`workbenchd`) that:
- manages the file-first operational store
- mediates all sandbox and shell execution
- handles session persistence and re-attachment
- drives preview deployment GC

Sessions are designed to survive client disconnects. A session can be detached (client exits) and later re-attached to resume agent execution.

## Task Lifecycle

Tasks follow this state machine:

```
pending
  → provisioning_runtime   (sandbox started, ports allocated, secrets injected)
  → running                (agent is active)
  → ready_for_review       (agent completed; awaiting human review)
  → merged                 (branch merged; preview GC triggered after delay)
```

Abort transitions directly to cleanup: ports released, preview GC triggered immediately.

## Session and Task Parallelism

- Multiple sessions can run in parallel within the same workspace.
- Multiple tasks can run in parallel within the same session.
- Best-of-N: multiple agents can work on the same task simultaneously when enabled.
- Task-level branch + worktree isolation ensures changes never conflict until merge.

## Workspace Status

```bash
workbench status
```

Returns: active tasks, port usage, runtime mode, daemon health.

## Secret Lifecycle

Secrets are deny-by-default. A task receives zero secrets unless explicitly listed with `--secret` at task creation time.

Provider allowlists in `workbench.yaml` restrict which agent providers can access which keys.

All secret access is logged to the audit trail.

## Preview Garbage Collection

Previews are automatically cleaned up:

| Trigger | Delay |
|---|---|
| Task merged | 1 hour |
| Task aborted | Immediate |
| Idle (no activity) | 7 days + 24h grace |
| Max active per workspace | 10 (configurable) |

## Docs Server Operations

Workbench wraps [`@arabold/docs-mcp-server`](https://www.npmjs.com/package/@arabold/docs-mcp-server) to index, search, and serve library documentation. All commands live under `workbench docs`:

```bash
workbench docs scrape <library> <url>   # Index docs from a URL into the local store
workbench docs search <library> <query> # Search indexed docs (+ optional --feed)
workbench docs fetch <url>              # Fetch a single URL as Markdown (no indexing)
workbench docs list                    # List indexed libraries and versions
workbench docs status                  # Indexed libraries + active embedding model
workbench docs server                  # Unified mode: MCP + SSE + web dashboard, one process
workbench docs web                     # Standalone web dashboard
workbench docs refresh <library>       # Re-scrape (ETag-aware, skips unchanged pages)
workbench docs remove <library>        # Remove a library from the index
```

### The docs store

The indexed-docs store lives at `.workbench/memory/.this/resources/docs` (resolved by `resolveDocsMcpDataDir()`; overridable via `WORKBENCH_DOCS_MCP_DATA_DIR`). Every docs command passes this path to `docs-mcp-server` through the **`DOCS_MCP_STORE_PATH`** environment variable, so all commands — the shell-out commands (`scrape`/`search`/`fetch`/`list`/`refresh`/`remove`) and the long-running `server`/`web` processes — resolve the same store.

### `server` and `web`

- `workbench docs server` runs in the foreground (`stdio: inherit`) until stopped. On startup it prints the bound MCP, SSE, and dashboard URLs. Defaults: `--port 6280`, `--host 0.0.0.0`.
- `workbench docs web` starts only the standalone dashboard. It first probes `http://<host>:<port>/`; if a docs service is already running it prints that URL and exits instead of starting a second instance.
- Both require `docs-mcp-server` to be installed. When the package is unavailable they print a clear message and exit non-zero.

### `--feed` into memory

`workbench docs search --feed` and `workbench docs fetch --feed <library>` route results into the file-first `.this` memory. Each result is always written into the built-in `FilesystemPlugin` (the default `.this` filestorage) under `{ scope: 'project', id: 'docs' }`, tagged with the library name and `docs-feed`. When a non-default memory plugin (e.g. OpenViking) is activated, results are additionally written through that plugin.

## Embedding-Model Setup

The embedding model used by the docs server is configured, optionally, via:

```bash
workbench init docs
```

This walks through a preset selection with three options:

| Preset | Model identifier | Base URL |
|---|---|---|
| `openai` | `openai:text-embedding-3-small` (default) | OpenAI native endpoint |
| `ollama` | `openai:<model>` | `http://localhost:11434/v1` (default) |
| `lm-studio` | `openai:<model>` | `http://localhost:1234/v1` (default) |

All three presets resolve to the `openai:<model>` identifier — `ollama` and `lm-studio` are consumed through `docs-mcp-server`'s OpenAI-compatible path.

Persistence:
- All settings persist to `~/.workbench.toml` — embedding model config under the `[docs]` section, API keys under the `[agents]` section.

At server startup `docsServerEnv()` reads the global config and exports `DOCS_MCP_EMBEDDING_MODEL` and `OPENAI_API_BASE` (and inherits `OPENAI_API_KEY` from the loaded credentials in `process.env`). If `init docs` was never run, no embedding env vars are set and `docs-mcp-server` falls back to its own built-in default. `workbench docs status` reports the active model (or notes the default and suggests running `init docs`).

## Port Leasing

Port allocation is file-first: an append-only JSON Lines log at `.workbench/leases.jsonl` (resolved by `resolveLeasesLog()`). There is no mutable row state — the set of active leases is derived by replaying the log (a `reserve` event adds a port, a `release` event removes it).

The allocator is constructed as `new PortAllocator(config.ports, workspaceId)`, where `config.ports` (range, reserve list, `strategy`, `staleTtl`) is read from `workbench.yaml` and `workspaceId` comes from `config.workspace.id`. Defaults: range `10000–10999`, `sequential` strategy, `staleTtl` 3600s.

Operations (all keyed on `sessionId`, not task id):

| Operation | Behavior |
|---|---|
| `reserve(sessionId, requests)` | Grants one lease per named request. Honors an explicit requested `port` when free; otherwise auto-allocates from the configured range. Each candidate is TCP-probed (bind attempt on 127.0.0.1) before granting. Returns the granted leases; appends one `reserve` event per port. |
| `release(sessionId)` | Appends a `release` event for every active lease held by the session. Called on every terminal task transition (`merged`/`aborted`). |
| `reclaim()` | Scans reserved leases older than `staleTtl`, probes each port, and appends a `release` event when the port is unreachable (no live process holds it). |
| `list({ sessionId, workspaceId })` | Returns current active leases, optionally filtered. |

Auto-allocation throws a named `PORT_RANGE_EXHAUSTED` error (`PortAllocationError`) that surfaces the configured range and the active lease count when no free port remains.


## DX Initialization Wizard (Planned)

A guided `workbench hello` initialization flow is planned to walk through each pillar configuration (runtime, memory, credentials, agents) at workspace setup time. See [Review](../review/README.md) for current status.

## See Also

- [Architecture](../architecture/README.md) — system design, component topology
- [Runtime](../runtime/README.md) — runtime modes and isolation details
- [Usage](../usage/README.md) — CLI reference for all operational commands
