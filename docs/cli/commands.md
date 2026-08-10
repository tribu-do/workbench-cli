# Workbench CLI Command Reference

This document describes all commands available in the Workbench CLI.

## Global Options

All commands accept these global options:

| Option | Short | Type | Description |
|--------|-------|------|-------------|
| `--json` | `-j` | boolean | Output response as JSON |
| `--verbose` | `-v` | boolean | Include detailed output |
| `--help` | `-h` | - | Show help for command |
| `--version` | - | - | Show CLI version |

## Commands

### workbench

Root command group for core workbench operations.

#### workbench status

Show workbench status and active session info.

```bash
workbench status [options]
```

**Options:**

| Option | Short | Type | Default | Description |
|--------|-------|------|---------|-------------|
| `--json` | `-j` | boolean | false | Output status as JSON |
| `--verbose` | `-v` | boolean | false | Include detailed status |

**Output (human):**
```
Workbench CLI v0.1.0
  Domains: 1
  Actions: 1
  Workspace: ws-123
  Session: sess-456
  Task: task-789
  Runtime: local available
  Memory: stub backend
```

**Output (JSON):**
```json
{
  "command_path": "workbench status",
  "result_state": "success",
  "resolved_identities": {
    "workspace_id": "ws-123",
    "session_id": "sess-456",
    "task_id": "task-789"
  },
  "data": {
    "cli_version": "0.1.0",
    "domain_count": 1,
    "action_count": 1,
    "workspace_id": "ws-123",
    "session_id": "sess-456",
    "task_id": "task-789",
    "runtime_state": {
      "local_available": true,
      "container_available": false,
      "daemon_available": false
    },
    "memory_backend": "stub"
  },
  "warnings": [],
  "errors": []
}
```

#### workbench manifest

Generate the CLI manifest for introspection.

```bash
workbench manifest [options]
```

**Options:**

| Option | Short | Type | Default | Description |
|--------|-------|------|---------|-------------|
| `--json` | `-j` | boolean | false | Output manifest as JSON |

**Output:** Returns the complete CLI manifest including domains, actions, and integration refs.

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error (validation, runtime, boundary) |
| 130 | User cancellation (SIGINT) |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `WORKBENCH_WORKSPACE` | Override workspace root path |

## Examples

```bash
# Show status in human format
workbench status

# Show status as JSON
workbench status --json

# Get CLI manifest
workbench manifest --json
```
