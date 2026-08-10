# Workbench Diagrams

Workbench manages Excalidraw diagrams as first-class artifacts. Every diagram is
generated from a natural-language prompt, stored under the workspace's
`.workbench/` directory, and tracked in a canonical index so it can be listed,
duplicated, previewed, and deleted without touching the filesystem by hand.

Three layers cooperate:

| Layer | Responsibility |
|---|---|
| **CLI** — `workbench diagrams` | User-facing commands over the library and preview service. |
| **`diagram.create` tool** | Agent-callable creation contract: prompt → plugin → managed artifact. |
| **Managed library** | On-disk layout, `index.json`, slug/filename rules, resolve and self-heal. |

## CLI

`workbench diagrams` exposes six commands. All take or print absolute file
paths, so command output pipes cleanly into the next command.

| Command | Description |
|---|---|
| `create <prompt...>` | Generate a new managed diagram from a natural-language prompt. |
| `duplicate <filepath>` | Straight copy of an existing managed diagram to a new UUID and file. |
| `list` | List managed diagrams (file paths; `-v` adds UUID and preview URL). |
| `preview <filepath>` | Print a read-only preview URL, starting the local viewer if needed. |
| `register <filepath>` | Move an existing `.excalidraw` file into the managed library. |
| `delete <filepath>` | Delete a managed diagram and its index entry. |

`create` accepts `--plugin <name>` (default `excalidraw`), `--slug <slug>` to
override the auto-generated slug, and `-v`/`--verbose` to print the UUID and full
artifact details as JSON instead of just the file path. `register` also accepts
`--slug`. Rename is intentionally not part of the v1 CLI surface.

```bash
# Create, then preview the diagram it produced
FILE=$(workbench diagrams create "auth sequence: client, gateway, token service")
workbench diagrams preview "$FILE"

# List with UUIDs and preview URLs
workbench diagrams list -v
```

`duplicate` is a byte-for-byte copy under a fresh UUID — it does not
prompt-improve the drawing. Any refinement of a duplicate is left to the calling
agent after the copy exists.

## Managed Library

Diagrams live under the workspace's Workbench directory:

| Path | Contents |
|---|---|
| `.workbench/diagrams/` | Managed `.excalidraw` files. |
| `.workbench/diagrams/index.json` | Canonical index (`version: 1`, array of entries). |

Each index entry records a `uuid`, the absolute `filePath`, and `createdAt` /
`updatedAt` timestamps. The library module owns all filesystem and index access;
neither the `diagram.create` tool nor the CLI reads or writes `index.json`
directly.

**Slug and filename.** Free text is turned into a filesystem-safe kebab-case
slug (lowercased, non-alphanumerics collapsed to `-`, trimmed, capped at 60
characters, falling back to `diagram` when empty). Managed files are named
`<uuid>--<slug>.excalidraw`, so the UUID guarantees uniqueness while the slug
keeps filenames human-readable. On `create` the slug is derived from the prompt
(or `--slug`); on `register` from the source filename (or `--slug`); on
`duplicate` it is carried over from the source file's basename.

**Resolve and self-heal.** Diagrams are resolved by absolute file path. The
index is treated as advisory over on-disk truth:

- Resolving an entry whose recorded file no longer exists removes that stale
  entry and reports the diagram as not found, with guidance to re-register it.
  Workbench never silently re-links a moved or externally edited file.
- `list` prunes every entry whose file is missing before returning, so listings
  never show diagrams that are gone.

## Plugins

`diagram.create` produces a scene through exactly one plugin per call, selected
by `--plugin` / the `plugin` input (a `DiagramPluginName`). The only registered
plugin in v1 is `excalidraw`, which is also the default.

A plugin implements a single `generate(prompt)` method returning a scene
document. The default Excalidraw plugin does not yet perform natural-language →
layout synthesis; it emits a minimal, valid Excalidraw scene containing the
prompt as a single text element, exercising the full create → persist → register
path end to end. The generator body can be replaced with a real NL→diagram
engine without changing the plugin interface or any caller.

**Plugin validation.** The `--plugin` value is validated against the registered
plugins. An unknown plugin is a generation failure, not a missing-argument
error: `create` returns the error code `drawing_could_not_be_generated` (with a
reason listing the available plugins), *not* `required_argument_missing`. The
latter is reserved for a genuinely empty prompt. `diagram.create`'s full error
vocabulary is:

| Error code | Meaning |
|---|---|
| `required_argument_missing` | The prompt was empty or whitespace. |
| `drawing_could_not_be_generated` | Unknown plugin, plugin threw, or scene could not be serialized. |
| `artifact_persist_failed` | The managed file could not be written to disk. |
| `artifact_register_failed` | The file was written but could not be added to the index. |
| `index_write_failed` | The index itself could not be written. |

## Preview Service

`workbench diagrams preview <filepath>` returns a URL to a **read-only** local
HTTP viewer that serves managed diagram content:

- `GET /<uuid>` returns the managed `.excalidraw` JSON.
- `GET /__health` returns `200 ok` and is used to detect a running viewer.
- Every other method or path returns `405` / `404` — the viewer never mutates.

The service is **detached**: if the configured port does not already answer the
health check, `preview` reserves the port and spawns a viewer process that
survives the CLI command that started it. A subsequent `preview` reuses the
already-running viewer rather than starting a second one.

**Port reservation.** The port is taken through the shared file-first
`PortAllocator` (the same reserve-before-grant allocator the operations domain
uses for task ports). Because the allocator keys every lease on a `sessionId` and
has no notion of a non-task service, the preview service reserves under a fixed
session-shaped id, `PREVIEW_SESSION_ID` (`diagrams-preview`). Using a stable id
lets a reused or reclaimed lease be recognized across CLI invocations. The
service never issues an explicit release; a dead viewer's stale lease is cleared
by the allocator's `reclaim()` pass.

**Configuration.** The port comes from the `diagrams.previewPort` config field,
which defaults to `5678`. Preview URLs are `http://localhost:<previewPort>/<uuid>`.

## See Also

- [Operations](../operations/README.md) — the `.workbench/` directory and the shared port-lease allocator.
- [Usage](../usage/README.md) — install and full CLI reference.
