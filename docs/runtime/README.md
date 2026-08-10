# Workbench Runtime

The runtime domain configures **runtime profiles**: named, reusable descriptions
of *where and how* a session's shell runs. Profiles are declared in
`workbench.yaml` and configured interactively with `workbench init sandboxing`.

Configuration is decoupled from provisioning. The registry validates, persists,
and logs profiles; it never launches a container or connects to a host. Starting
a session from a profile is a later concern.

## Runtime Profile Registry

Every profile lives under the `runtimes` map in `workbench.yaml`, keyed by
profile name, with `default_runtime` naming the profile `workbench session
create` offers first. A freshly initialized workspace always contains at least
the `bare-host` profile, and `default_runtime` points at it.

```yaml
default_runtime: bare-host
runtimes:
  bare-host:
    mode: bare-host
    label: Bare Host
    settings: {}
  api-stack:
    mode: docker-compose
    label: Docker Compose (api)
    settings:
      composeFile: ./docker-compose.yml
      service: api
      containerWorkspaceFolder: /workspace
    settingsRef: .workbench/runtimes/docker-compose/api-stack.yaml
```

Each entry is a `RuntimeProfileConfig`:

| Field | Meaning |
|---|---|
| `mode` | A supported `RuntimeModeId` (see below). |
| `label` | Human-readable name shown in menus and output. |
| `settings` | Settings the mode declares **shareable** — written inline, safe to commit. |
| `settingsRef` | Optional path to a per-profile **local/extended** settings file (see the tree below). Present only when the mode has local settings. |

Resolving a profile merges the inline `settings` with the referenced local
settings file when one exists; local settings win on key collision. Listing
profiles rejects (by throwing) the first profile whose `mode` is not a supported
identifier, naming both the profile and the offending mode.

### The `.workbench/runtimes/` tree

Local/extended settings and event logs live outside `workbench.yaml`:

```
.workbench/runtimes/
├── logs/
│   └── <mode>.jsonl              # append-only config event log, one file per mode
└── <mode>/
    └── <profile>.yaml            # local/extended settings for that profile
```

For example, the docker-compose mode writes a profile's SSH username and
generated keypair paths to `.workbench/runtimes/docker-compose/<profile>.yaml`
(referenced by `settingsRef`), while the shareable compose file, service, and
container workspace folder stay inline in `workbench.yaml`.

Every configuration attempt appends one JSON Lines record to
`.workbench/runtimes/logs/<mode>.jsonl` capturing the profile name, mode, probe
result (`passed` / `failed` / `skipped`), whether it overwrote an existing
profile, and the outcome (`configured` / `aborted` / `failed`), plus mode-specific
detail.

## Runtime Modes

A runtime mode identifies the isolation mechanism a profile uses. The supported,
persistable set is the closed `RuntimeModeId` union:

| Mode (`RuntimeModeId`) | Configurable today | Notes |
|---|---|---|
| `bare-host` | Yes | Direct host execution. No local settings; inline settings are empty. |
| `docker-compose` | Yes | Config-only: probes and records an existing user compose stack. Does not run containers. |
| `devcontainer` | Reserved | Member of the union, but no configuration flow yet. |
| `aio-sandbox` | Reserved | Member of the union, but no configuration flow yet. |

### Selection menu vs. the persistable union

The `workbench init sandboxing` picker renders `RUNTIME_MENU`, which is
deliberately **decoupled** from `RuntimeModeId`. The menu lists every mode in a
stable order and marks the ones that cannot yet be selected as `(unavailable)`
with a reason:

| Menu entry | State |
|---|---|
| Bare Host | available |
| Docker Compose | available |
| Devcontainer | unavailable — not yet drafted |
| AIO Sandbox | unavailable — not yet drafted |
| NVIDIA Shell | unavailable — planned, menu only |

`nvidia-shell` is a menu-only placeholder: its id is intentionally **not** a
`RuntimeModeId`, so it can never be selected, validated, or persisted. Undrafted
union members (`devcontainer`, `aio-sandbox`) appear disabled the same way until
their configuration flow lands. Selecting an unavailable entry is refused before
any settings are collected.

## `workbench init sandboxing`

Configures one runtime profile. The flow is:

1. **Select a mode** from the menu; unavailable entries are refused.
2. **Name the profile** (a mode may hold more than one). Re-using an existing
   name requires `--overwrite`, otherwise the command aborts.
3. **Probe host prerequisites** for the mode *before* collecting any settings.
4. **Collect settings, write, and log** on success.

### Probe failure writes nothing

If the prerequisite probe fails, the command writes **nothing**: no profile
entry in `workbench.yaml`, no local settings file, and **no log event**. The
`.workbench/runtimes/` tree (including its `logs/` directory) is left completely
untouched. Only a run that passes its probe records anything.

### bare-host

Has no external prerequisite, so its probe always passes. Writes an inline
profile with empty settings and logs a `configured` event. No local settings
file is created.

### docker-compose (config-only)

The probe checks that `docker compose` resolves as a subcommand and that the
daemon responds to `docker info`. On success the flow:

- Verifies the compose file exists and the chosen service is declared in the
  resolved config (both are named-error aborts if not).
- Generates a dedicated ed25519 SSH keypair under
  `.workbench/runtimes/docker-compose/`, private key `0600`.
- Splits settings: compose file, service, and container workspace folder inline;
  SSH username and keypair paths to the local settings file.
- Prints VSCode Remote-SSH connect instructions and logs a `configured` event.

If configuration fails after the keypair was generated, the keypair and the
profile's local settings file are rolled back, and a `failed` event is logged.
This mode records and describes an existing stack — it does **not** start,
build, or attach to any container. Session launch and the actual VSCode attach
are a later concern.

## Coexistence with the legacy `runtime.mode`

The `runtime.mode` field in `workbench.yaml` (values `daemon-managed`,
`dev-managed`, `bare-host` — the `RuntimeMode` type) is a **separate, legacy**
setting used by the task engine. It is unrelated to the runtime profile
registry and its `RuntimeModeId` values, and both remain in the config side by
side. Do not conflate the two: `runtimes` / `default_runtime` (profiles) drive
session runtimes; `runtime.mode` drives task-engine isolation policy.

## See Also

- [Architecture](../architecture/README.md) — component topology and policy invariants
- [Operations](../operations/README.md) — daemon lifecycle and `.workbench/` directory
- [Usage — Configuration](../usage/README.md#configuration) — `workbench.yaml` runtime settings
