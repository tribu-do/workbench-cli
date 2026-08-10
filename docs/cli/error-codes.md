# Error Code Reference

This document lists all error codes that the Workbench CLI can return.

## Validation Errors

Errors from schema and input validation.

| Code | Message | Resolution |
|------|---------|------------|
| `MISSING_REQUIRED_ARG` | Missing required argument: {name} | Provide the required argument |
| `INVALID_ARG_TYPE` | Invalid type for argument {name}: expected {type} | Use correct value type |
| `MISSING_REQUIRED_OPTION` | Missing required option: --{name} | Provide the required option |
| `INVALID_OPTION_TYPE` | Invalid type for option --{name}: expected {type} | Use correct value type |
| `INVALID_OPTION_CHOICE` | Invalid choice for option --{name}: must be one of {choices} | Use a valid choice |

## Identity Errors

Errors from identity resolution.

| Code | Message | Resolution |
|------|---------|------------|
| `MISSING_SESSION_IDENTITY` | This action requires an active session | Start or attach a session first |
| `MISSING_TASK_IDENTITY` | This action requires an active task | Create or resume a task first |
| `MISSING_WORKSPACE_IDENTITY` | This action requires a workspace context | Set workspace or run from workspace directory |

## Execution Mode Errors

Errors from execution mode resolution.

| Code | Message | Resolution |
|------|---------|------------|
| `EXECUTION_MODE_NOT_SUPPORTED` | This action does not support {mode} mode | Use a supported execution mode |
| `MISSING_NON_INTERACTIVE_ARGS` | Non-interactive execution requires: {args} | Provide required args for non-interactive mode |
| `NO_TTY_FOR_INTERACTIVE` | Interactive mode requires a TTY | Run from interactive terminal |
| `JSON_INCOMPATIBLE_WITH_INTERACTIVE` | This action does not support --json | Remove --json flag |
| `CONFLICTING_FLAGS` | Cannot specify both --interactive and --non-interactive | Use one mode flag |

## Dispatch Errors

Errors from handler dispatch.

| Code | Message | Resolution |
|------|---------|------------|
| `HANDLER_NOT_FOUND` | Handler not found: {handler_id} | Internal error — handler not registered |
| `HANDLER_ERROR` | {error message} | Check error message for details |

## Registry Errors

Errors from registry loading.

| Code | Message | Resolution |
|------|---------|------------|
| `FILE_NOT_FOUND` | Registry not found at {path} | Create registry.json |
| `PARSE_ERROR` | Failed to parse {path}: {details} | Fix JSON syntax in registry |
| `MISSING_OWNER_DOMAIN` | Domain '{name}' is missing owner_domain | Add owner_domain field |
| `DUPLICATE_DOMAIN` | Duplicate domain name: '{name}' | Remove duplicate domain entry |
| `UNKNOWN_ACTION` | Domain '{domain}' references unknown action: '{action}' | Register the action schema |

## Registration Errors

Errors from command registration.

| Code | Message | Resolution |
|------|---------|------------|
| `PATH_COLLISION` | Multiple actions resolve to the same command path: {path} | Rename conflicting actions |
| `UTILITY_SHADOWS_DOMAIN` | Root utility '{name}' shadows domain command name | Rename utility or domain |

## Memory Errors

Errors from memory domain operations.

| Code | Message | Resolution |
|------|---------|------------|
| `BUDGET_EXCEEDED` | Memory request exceeded budget limits | Reduce memory request scope |
| `SCOPE_NOT_FOUND` | Requested memory scope does not exist | Check scope identifiers |
| `BACKEND_UNAVAILABLE` | Memory backend is not available | Check memory backend configuration |
| `SEARCH_TIMEOUT` | Memory search exceeded timeout | Narrow search query |
| `ACCESS_DENIED` | Not authorized for requested memory intent | Check permissions |

## Runtime Errors

Errors from runtime domain operations.

| Code | Message | Resolution |
|------|---------|------------|
| `SANDBOX_UNAVAILABLE` | Sandbox environment not available | Install/start sandbox backend |
| `POLICY_DENIED` | Execution denied by policy | Check policy configuration |
| `TIMEOUT_EXCEEDED` | Execution timeout exceeded | Increase timeout or simplify command |
| `EXEC_FAILED` | Command execution failed | Check command and arguments |
| `MODE_NOT_SUPPORTED` | Runtime mode not supported | Use supported runtime mode |
| `TTY_NOT_AVAILABLE` | TTY not available for runtime | Use non-TTY runtime mode |

## Refusal Errors

Errors from refusal handlers (cancellation, mode resolution).

| Code | Message | Resolution |
|------|---------|------------|
| `USER_CANCELLED` | Operation cancelled by user | User intentionally cancelled |
| `CLI_ERROR` | {error message} | Check error message for details |

## Error Response Format

All errors are returned in the standard JSON envelope:

```json
{
  "command_path": "workbench status",
  "result_state": "error",
  "resolved_identities": {},
  "data": null,
  "warnings": [],
  "errors": [
    {
      "code": "MISSING_SESSION_IDENTITY",
      "message": "This action requires an active session",
      "field_path": "identity.sessionId",
      "kind": "validation"
    }
  ]
}
```

## Programmatic Error Handling

```typescript
const result = JSON.parse(stdout);

if (result.result_state === 'error') {
  for (const error of result.errors) {
    switch (error.code) {
      case 'MISSING_SESSION_IDENTITY':
        // Start a session first
        break;
      case 'HANDLER_NOT_FOUND':
        // Internal error
        break;
      default:
        console.error(`Error: ${error.message}`);
    }
  }
}
```
