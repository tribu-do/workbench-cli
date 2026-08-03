# Workbench

AI-first sandboxed agentic development. Task orchestration, hierarchical memory, sandbox mediation, multi-agent parity, and pluggable deployment — as a single CLI tool.

Workbench gives AI coding agents (Claude, Codex, Copilot) a structured environment: every task gets a branch, a sandbox, scoped memory, port allocation, secret injection, and a preview deployment. It works with new and existing projects.

## Install

```bash
npm install @tribu-do/workbench-cli
```

Or run directly with npx:

```bash
npx @tribu-do/workbench-cli --help
```

Requires Node.js >= 20.

## Quick start

```bash
# Initialize in any project directory
workbench init --name my-project

# Create a task (provisions sandbox, allocates ports, enforces policy)
workbench task create "fix-auth-bug" --provider claude

# Check workspace status
workbench status
```

This creates a `workbench.yaml` config and a `.workbench/` directory (auto-added to `.gitignore`) containing file-based state.

## Concepts

**Task** — The unit of work. Each task gets a git branch, a runtime sandbox, scoped memory, and optionally a preview deployment. Tasks follow a state machine: `pending` > `provisioning_runtime` > `running` > `ready_for_review` > `merged`.

**Runtime modes** — Controls isolation level and what agents are allowed to do:

| Mode | Isolation | auto_approve | Use case |
|---|---|---|---|
| `daemon-managed` | Strong | Allowed | Default. AIO sandbox wraps all shell calls. |
| `dev-managed` | Medium | Conditional | Your own `docker-compose` stack. Workbench connects via SSH + shim. |
| `bare-host` | Weak | Forbidden | No container. Observe-only. |

**Scope cascade** — Memory, secrets, and skills resolve deepest-first: task > session > workspace > global. A task-scoped secret overrides a workspace-scoped one.

**Policy engine** — Evaluates runtime probes at task creation. If mediation layers aren't healthy, `auto_approve` is downgraded and the task enters `downgraded` state. This is enforced at provisioning, not runtime.

## CLI reference

### `workbench init`

Initialize a workspace in the current directory.

```bash
workbench init --name my-project --mode daemon-managed --provider coolify
```

| Option | Default | Description |
|---|---|---|
| `--name` | directory name | Workspace name |
| `--mode` | `daemon-managed` | Runtime mode |
| `--provider` | `coolify` | Default preview provider |

### `workbench task`

Manage tasks.

```bash
# Create a task with port allocation and secret access
workbench task create "add-payments" \
  --provider claude \
  --branch feat/payments \
  --port http:3000 --port debug:9229 \
  --secret DATABASE_URL --secret STRIPE_KEY

# List all tasks
workbench task list
workbench task list --state running

# Show task details (state, ports, recent events)
workbench task status <taskId>

# Transition state
workbench task transition <taskId> ready_for_review
workbench task transition <taskId> merged

# Abort a task (releases ports, triggers preview GC)
workbench task abort <taskId>
```

### `workbench skill`

Manage reusable skills with scope-based resolution.

```bash
# Install a skill at global scope
workbench skill install code-review "Code Review" \
  -d "AI-powered code review" \
  --provider claude \
  --entrypoint ./skills/review.md

# List skills
workbench skill list
workbench skill list --scope workspace --scope-id my-project

# Promote from workspace to global
workbench skill promote code-review \
  --from-scope workspace --from-id my-project \
  --to-scope global

# Remove
workbench skill remove code-review
```

### `workbench mcp`

Manage MCP (Model Context Protocol) servers.

```bash
# Install a stdio-based MCP server
workbench mcp install fs-server "Filesystem" \
  -t stdio \
  -c "npx" --args "-y" "@anthropic/mcp-fs"

# Install an SSE-based server
workbench mcp install api-server "API Server" \
  -t sse --url http://localhost:8080/sse

# List servers
workbench mcp list
```

### `workbench memory`

Hierarchical memory with scope cascade.

```bash
# Store a record
workbench memory put preferences theme --body "dark"
workbench memory put decisions auth-strategy --body "JWT with refresh tokens" \
  --scope workspace --scope-id my-project

# Retrieve (walks cascade: task > session > workspace > global)
workbench memory get preferences theme
workbench memory get decisions auth-strategy --workspace-id my-project

# List records at a scope
workbench memory list --scope global
workbench memory list --scope workspace --scope-id my-project --namespace decisions

# Search by content
workbench memory search "auth"

# Promote a record to a higher scope
workbench memory promote <recordId> --to-scope global

# Delete
workbench memory delete <recordId>
```

### `workbench secret`

Scoped, encrypted, audited secret management. Deny-by-default: tasks receive zero secrets unless explicitly allowlisted.

```bash
# Store a secret (encrypted at rest with AES-256-GCM)
workbench secret set DATABASE_URL "postgres://..."
workbench secret set STRIPE_KEY "sk_live_..." --scope workspace --scope-id my-project

# Rotate a value
workbench secret rotate DATABASE_URL "postgres://new-host/..."

# Revoke across all scopes
workbench secret revoke OLD_API_KEY

# View audit log
workbench secret audit
workbench secret audit --key DATABASE_URL
workbench secret audit --action resolve --task-id <taskId>
```

Secrets are only injected into tasks that list them in `--secret`. Per-provider allowlists in `workbench.yaml` restrict which agent providers can access which keys.

### `workbench deploy`

Preview deployments via Coolify (full-stack), Netlify (static), or Cloudflare (edge).

```bash
# Deploy a preview
workbench deploy preview <taskId>
workbench deploy preview <taskId> --provider netlify --build-command "npm run build"

# Check status
workbench deploy status <taskId>

# Tear down
workbench deploy destroy <taskId>
```

Previews are garbage-collected automatically: on merge (1h delay), on abort (immediate), on idle (7d + 24h grace).

### `workbench status`

Quick workspace overview — active tasks, port usage, runtime mode.

```bash
workbench status
```

## Configuration

`workbench.yaml` at the project root. Generated by `workbench init`.

```yaml
version: "1"
workspace:
  id: a1b2c3d4
  name: my-project

runtime:
  mode: daemon-managed    # daemon-managed | dev-managed | bare-host
  # composeFile: docker-compose.yml   # required for dev-managed
  # sshTarget: user@host              # required for dev-managed

preview:
  default: coolify        # coolify | netlify | cloudflare
  rules:
    - when: "artifact.kind == 'static'"
      provider: netlify
    - when: "artifact.kind == 'edge'"
      provider: cloudflare
  gc:
    afterMergeDelayMs: 3600000
    suspendTtlMs: 259200000
    idleTtlMs: 604800000
    maxActivePerWorkspace: 10

ports:
  enabled: true
  range: [10000, 10999]
  strategy: sequential    # sequential | random
  staleTtl: 3600

secrets:
  backend: file           # file | vault | aws-sm
  providerAllowlists:
    claude: [DATABASE_URL, REDIS_URL, APP_SECRET]
    codex: [DATABASE_URL, REDIS_URL, OPENAI_API_KEY]
    copilot: [DATABASE_URL]
  requireTmpfsInDevManaged: true

agents:
  providers:
    - name: claude
      enabled: true
      mcpEnabled: true
    - name: codex
      enabled: true
    - name: copilot
      enabled: false
```

## Credentials

Service credentials (Coolify, Netlify, Cloudflare, etc.) are stored in `~/.workbench` in your home directory. This file is never committed.

```bash
touch ~/.workbench && chmod 600 ~/.workbench
```

```bash
# Coolify (default preview provider)
export WORKBENCH_COOLIFY_URL="https://your-coolify-instance.example.com"
export WORKBENCH_COOLIFY_TOKEN="your-api-token"

# Netlify
export WORKBENCH_NETLIFY_TOKEN="your-netlify-token"
export WORKBENCH_NETLIFY_SITE_ID="your-site-id"

# Cloudflare
export WORKBENCH_CLOUDFLARE_API_TOKEN="your-cf-token"
export WORKBENCH_CLOUDFLARE_ACCOUNT_ID="your-account-id"
```

See [CREDENTIALS-SETUP.md](CREDENTIALS-SETUP.md) for full setup instructions.

## Programmatic API

Workbench exports all services for use in scripts, custom tooling, or daemon integration:

```ts
import {
  createWorkbench,
  type TaskSpec,
  type WorkbenchContext,
} from '@tribu-do/workbench-cli';

const wb: WorkbenchContext = createWorkbench();

// Create a task
const task = await wb.orchestrator.createTask({
  name: 'my-task',
  runtimeMode: 'bare-host',
  aiAgentProvider: 'claude',
});

// Store memory
wb.memoryService.put('global', 'global', 'notes', 'arch-decision', 'Use event sourcing');

// Install a skill
wb.skillsRegistry.installSkill('global', 'global', {
  id: 'review',
  name: 'Code Review',
  description: 'AI code review',
  version: '1.0.0',
});

// Store a secret
wb.secretManager.set('workspace', 'my-project', 'DB_URL', 'postgres://...');

// Clean up
wb.close();
```

## Architecture

```
workbenchd
  Orchestrator ─ MemoryService ─ SkillsRegistry ─ SandboxBroker
       |              |               |               |
       |          File Store      Scope cascade    PolicyEngine
       |              |                               |
       ├── PortAllocator         Runtime probes ──────┘
       └── SecretManager         (AIO / shim / pty-wrap)
              |
         AES-256-GCM              DeploymentProvider
         audit trail               ├─ Coolify (full-stack)
                                   ├─ Netlify (static)
                                   └─ Cloudflare (edge)
```

**File-first store** — All state lives in `.workbench/` as structured files (YAML manifests, JSON Lines event logs, markdown journals). No database dependencies.

**Policy invariants** enforced at task provisioning:
- `auto_approve=true` + bare-host = refused
- Secrets requested + unenforceable mode = refused
- Every `exec` call logged regardless of mode
- Mode transitions mid-task are forbidden

## Development

```bash
npm install
npm run typecheck    # type-check without emitting
npm run build        # compile to dist/
npm run dev          # run directly during development
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

MIT — Richard Blondet, Claude (Anthropic), Codex (OpenAI)
