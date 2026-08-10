# JSON Output Schema Reference

All CLI commands support `--json` output mode. This document describes the JSON response envelope structure.

## JsonResponse Envelope

Every JSON response follows this structure:

```typescript
interface JsonResponse<T = unknown> {
  command_path: string;
  result_state: ResultState;
  resolved_identities: ResolvedIdentities;
  data: T | null;
  warnings: JsonWarning[];
  errors: JsonError[];
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `command_path` | string | The full command path (e.g., "workbench status") |
| `result_state` | ResultState | Outcome of the command |
| `resolved_identities` | ResolvedIdentities | Identity context for the request |
| `data` | T \| null | Command-specific response data |
| `warnings` | JsonWarning[] | Non-fatal warnings |
| `errors` | JsonError[] | Errors that prevented success |

## Result States

The `result_state` field indicates the command outcome:

| State | Exit Code | Description |
|-------|-----------|-------------|
| `success` | 0 | Command completed successfully |
| `partial` | 0 | Command completed with warnings |
| `error` | 1 | Command failed with errors |

## Resolved Identities

Identity context resolved for the request:

```typescript
interface ResolvedIdentities {
  workspace_id?: string;
  session_id?: string;
  task_id?: string;
}
```

Fields are present when resolved from CLI flags, attached session context, or workspace defaults.

## Warnings

Non-fatal issues that don't prevent success:

```typescript
interface JsonWarning {
  code: string;
  message: string;
  field_path?: string;
}
```

## Errors

Issues that prevented successful completion:

```typescript
interface JsonError {
  code: string;
  message: string;
  field_path?: string;
  kind?: 'validation' | 'identity' | 'runtime' | 'boundary';
}
```

### Error Kinds

| Kind | Description |
|------|-------------|
| `validation` | Schema or input validation failure |
| `identity` | Identity resolution failure |
| `runtime` | Runtime execution failure |
| `boundary` | Domain boundary refusal |

## Examples

### Success Response

```json
{
  "command_path": "workbench status",
  "result_state": "success",
  "resolved_identities": {
    "workspace_id": "ws-123",
    "session_id": "sess-456"
  },
  "data": {
    "cli_version": "0.1.0",
    "domain_count": 1,
    "action_count": 1
  },
  "warnings": [],
  "errors": []
}
```

### Error Response

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

### Partial Response

```json
{
  "command_path": "workbench manifest",
  "result_state": "partial",
  "resolved_identities": {
    "workspace_id": "ws-123"
  },
  "data": {
    "manifest_version": "1.0.0",
    "domains": []
  },
  "warnings": [
    {
      "code": "EMPTY_DOMAINS",
      "message": "No domains registered"
    }
  ],
  "errors": []
}
```

## Machine Consumption

When consuming JSON output programmatically:

1. Check `result_state` first to determine overall success
2. Access `data` only when `result_state` is `success` or `partial`
3. Check `errors` array when `result_state` is `error`
4. Use `resolved_identities` to understand the request context
5. Exit code maps directly from `result_state`:
   - `success` or `partial` → 0
   - `error` → 1
