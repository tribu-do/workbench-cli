# Workbench Memory

## Architecture

Memory is a **pluggable backend behind one contract**. The built-in filesystem `.this` layer is the
default plugin and the **source of truth**; every record is a Markdown file with YAML frontmatter
under `.workbench/memory/`. A fresh `git clone` with no prebuilt index exposes the whole durable
tree from files alone. Optional plugins (OpenViking) **index over `.this`** rather than replacing it,
so deactivating a plugin never loses authored memory.

| Layer | Role |
|---|---|
| Built-in `filesystem` plugin (`.this`) | Default, always active, source of truth. Markdown + frontmatter records; grep search. |
| OpenViking plugin (optional) | Derived vector/semantic index over `.this`. Opt-in via config; degrades to the built-in layer when off or unhealthy. |

### The `MemoryPlugin` contract

Every backend implements the single interface in `tools/workbench/src/memory/interface.ts`:

| Group | Methods |
|---|---|
| Write | `put(scope, record, meta)` → stable `RecordUri` |
| Extraction | `extract(sessionId)` — episodic → semantic/procedural at a session boundary |
| Retrieval | `search(query)` — budgeted, layered (`l0`/`l1`/`l2`) |
| Promotion | `promote(from, to, opts)` — narrow → wide |
| Portability | `export`, `import`, `renderAgentsMd` |
| Admin | `backendTest()`, `diff(sessionId)`, `stats(scope?)` |

A plugin advertises its `capabilities` (`scopes` + `features`: `vector`, `rerank`, `graph`,
`relations`, `export`, `l0l1l2`). Retrieval degrades against those capabilities — no `vector` falls
back to path + grep, no `rerank` returns fetch order, no `export` degrades to Markdown.

### Plugin registry and fallback

`resolveMemoryPlugin(config?)` (`tools/workbench/src/memory/registry.ts`) is the single place that
decides the active plugin. It reads `config.memory?.plugin`, defaults to the built-in `filesystem`
plugin, and **falls back to the built-in layer** whenever the requested plugin is unknown, cannot be
instantiated, or fails its `backendTest()` health check — so memory always works from files. All
services take a `MemoryPlugin` and never branch on plugin name.

Activation is config-driven, never a CLI subcommand:

```yaml
# workbench.yaml — default is the built-in .this layer
memory:
  plugin: filesystem        # set to 'openviking' to activate the derived index
```

## Scope Hierarchy

Six scopes. Reads are downward-inclusive (a task read sees project/agent/user/org); writes land in
the narrowest scope. `org` is read-only to agents; `task` is the default write target; `session` is
scratch.

```
org  →  user  →  agent  →  project  →  task  →  session
```

## The `.this` default layer

The durable tree lives under `.workbench/memory/.this/` (resolved by `resolveMemoryThisDir()` in
`config.ts`). `init` scaffolds it idempotently via `scaffoldThisMemory()`.

```text
.workbench/memory/
  .this/                       # authored source of truth
    resources/                 # shipped local knowledge
      skills/  mcps/  design-system/  docs/
    user/                      # project-local user knowledge
      preferences/ decisions/ constraints/ operations/
      harness/ patterns/ planning/ extractions/
    agents/<agent-id>/         # repo-local agent overlays
    journals/<YYYY_MM_DD>/<task-id>/   # dated episodic layout
      journal.md
      memory-diff.json
      promotion-diff.json
      scratch/<kind>/<slug>.md
  openviking/                  # derived index of an activated plugin (NOT a store of record)
```

Scope-to-subtree mapping used by the built-in adapter: `org` → `resources/org`, `user`/`project` →
`user`, `agent` → `agents/<id>`, and `task`/`session` → `journals/<YYYY_MM_DD>/<id>/scratch`. Runtime
identifiers such as `session_id` live inside `journal.md` frontmatter, not as directory keys.
Derived artifacts (indexes) sit **beside** `.this` (e.g. `openviking/`); deleting them loses nothing.

### Record kinds and grounding

Records carry a `kind`: `decision`, `constraint`, `preference`, `case`, `pattern`, `tool-lesson`,
`skill`, `entity`, `event`. **Writes require grounding** — a record must reference at least one
`GroundingRef` (`turn`, `tool-output`, `test-result`, `file`, or `commit`); the built-in `put()`
rejects ungrounded records at the write path.

### Reversible audit diff

`put()` emits no per-write diff (it has no session context). The reversible audit record is produced
at the **session boundary**: `extract(sessionId)` writes `memory-diff.json` into the task journal,
and `diff(sessionId)` reads it back. Until the operations extraction pipeline lands, the built-in
`extract()`/`diff()` return empty, reversible envelopes — a marked coverage floor, not a silent gap.

## OpenViking Plugin

Optional, off by default, activated with `memory.plugin: openviking`. It does not own memory: writes
go through the built-in `.this` adapter first, then get indexed; the index is always reconstructable
from `.this`.

- **Transport** — a running HTTP server (`WORKBENCH_OPENVIKING_URL`, default `http://localhost:1933`,
  `/v1/*` routes), with the embedded Python `SyncOpenViking` SDK (`python3 -c`) as fallback. There is
  **no `@openviking/client` npm package.**
- **Workspace** — the derived index lives at `resolveOpenVikingWorkspace()`
  (`.workbench/memory/openviking/`), beside `.this`.
- **LanceDB** — the vector store is **internal to the OpenViking service**; this adapter reaches
  semantic retrieval only through `/v1/find` (or `client.find(...)`) and never imports LanceDB.
- **Session commit** — `extract()` calls OpenViking's `commit_session`, triggering its self-iteration
  loop that writes extracted records back into `.this`.
- **Activation just works** — no migration; the index builds over the existing `.this` tree on first
  use. Deactivating (set `filesystem` or delete `openviking/`) leaves `.this` untouched; search
  degrades to grep.

## CLI

`workbench memory` exposes two surfaces.

### Path-first `.this` tree (mirrors the durable layout)

Addresses files under `.this` directly. Every verb blocks `..` escapes out of the subtree.

```bash
workbench memory this show            # print the .this root path
workbench memory this tree            # find -maxdepth 3 over .this

# resources | user | agents each support: ls | read | add | grep | rm
workbench memory user ls decisions
workbench memory user read decisions/use-file-first-store.md
workbench memory agents add codex/tool-lessons/use-rg.md --text "Use rg before grep"
workbench memory resources grep "design-system"

# journals add open + append on top of the shared verbs
workbench memory journals open 2026_07_15/task-fs-layout
workbench memory journals append 2026_07_15/task-fs-layout --section Notes --text "..."
workbench memory journals read 2026_07_15/task-fs-layout/memory-diff.json
```

Plugin activation and harness operations (search/inject/extract/promote/render) are intentionally
**not** in this surface — activation is config-driven, and memory lifecycle operations belong to the
operations domain.

### Hierarchical record commands

Namespace/key records addressed by scope (`global` | `workspace` | `session` | `task`), backed by
`memoryService`:

```bash
workbench memory put <namespace> <key> --body "<value>" --scope workspace --scope-id <id>
workbench memory get <namespace> <key>                    # walks the scope cascade
workbench memory list --scope global --namespace <ns>
workbench memory search "<query>" --scope workspace --scope-id <id>
workbench memory promote <id> --to-scope global
workbench memory delete <id>
```

## Source

| File | Role |
|---|---|
| `tools/workbench/src/memory/interface.ts` | `MemoryPlugin` contract + record/scope/query types |
| `tools/workbench/src/memory/registry.ts` | `resolveMemoryPlugin` — default + fallback |
| `tools/workbench/src/memory/scaffold.ts` | `scaffoldThisMemory` — idempotent `.this` tree |
| `tools/workbench/src/memory/adapters/filesystem.ts` | Built-in `.this` plugin (source of truth) |
| `tools/workbench/src/memory/adapters/openviking.ts` | OpenViking plugin (derived index) |
| `tools/workbench/src/cli/commands/memory.ts` | `workbench memory` CLI (both surfaces) |

## See Also

- [Architecture](../architecture/README.md) — scope cascade and memory in component topology
- [Usage — workbench memory](../usage/README.md#workbench-memory) — CLI reference
- [Review](../review/README.md) — review history and outstanding gaps
