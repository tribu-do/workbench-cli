# Workbench Review

## Current State

Three implementation reviews have been conducted. The current premise adherence score is **8.2 / 10**.

## Review History

### Review 0 — Score: 6.1 / 10

Key findings:
- Critical: Core execution model (worktree + agent + sandbox) not implemented
- Critical: No first-class session model
- High: Secret injection path not executed
- High: Port auto-allocation broken
- High: Deployment adapters unreliable
- Low: `workbench hello` bootstrap command missing

### Review 1 — Score: 7.8 / 10

What improved:
- Sessions are first-class with CLI commands
- Worktree creation/removal in orchestrator lifecycle
- Daemon-managed Docker runtime path exists
- Port auto-allocation working
- Skills symlink behavior implemented
- Deploy status with live provider polling
- `workbench hello` and `workbench gc` added

Remaining gaps:
- Critical: Shell execution not mediated through Sandbox broker
- High: `session stop` aborts without resource cleanup
- High: Auto-approve default wrong (was opt-in, should be default-on)
- High: No Codex/Copilot runtime support
- High: No OpenViking/LanceDB memory

### Review 2 — Score: 8.2 / 10

What improved:
- CLI `auto_approve` defaults to enabled (`--no-auto-approve` to opt out)
- Provider selection with session-level agent fallback
- Docker runtime includes agent CLI provisioning attempt
- Schema captures session agent selection

Remaining gaps:
- Critical: Sandbox broker still not on agent execution path
- High: `session stop` still bypasses orchestrator cleanup hooks
- High: Auto-approve inconsistency between CLI and programmatic API
- High: Codex/Copilot runtime not implemented
- Medium: Dev-managed secret injection is policy-only

## Outstanding Items

### P0 (Blocking)

| Item | Status |
|---|---|
| Memory architecture correction (OpenViking as canonical layer) | Not implemented |
| Runtime architecture correction (AIO Sandbox / OpenShell / devcontainer backends) | Sandbox broker not on execution path |
| Durable session orchestration (detach/attach/resume) | Not implemented |
| Initialization wizard by pillar (`workbench hello`) | Not implemented |
| Documentation grounding integration (`@arabold/docs-mcp-server`) | Not implemented |

### P1

| Item | Status |
|---|---|
| Task wizard UX (`@clack/prompts`) | Not implemented |
| Status truth model | Not implemented |
| Worktree strategy redesign | Not implemented |

### P2

| Item | Status |
|---|---|
| Notifications and session-completion ergonomics | Not implemented |
| Expanded provider/model strategy (free-model lanes like Ollama) | Not implemented |

## Pillar-by-Pillar Status

| Pillar | Expected | Current State | Status |
|---|---|---|---|
| Unified memory | OpenViking-centered contextual memory | File-first memory; OpenViking/LanceDB not integrated | Not Implemented |
| Sandboxed runtime sessions | AIO Sandbox / OpenShell / devcontainer | Mostly Docker/worktree path; AIO/OpenShell not integrated | Not Implemented |
| Skills + MCP management | Project-scoped with agent wiring | Skill/MCP metadata + some symlink support | Needs Validation |
| Re-attachable sessions | tmux-like detach/attach | Session records exist; durable orchestration not complete | Not Implemented |
| Preview lanes | Coolify/Netlify/Cloudflare | Adapters exist; end-to-end validation pending | Needs Validation |

## See Also

- [Architecture](../architecture/README.md) — premise contract and design principles
- [QA](../qa/README.md) — test approach and acceptance criteria
- [Memory](../memory/README.md) — memory implementation status (P0)
- [Runtime](../runtime/README.md) — sandbox strategy and current implementation gaps
