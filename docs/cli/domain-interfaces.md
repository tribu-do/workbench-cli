# Domain Interface Contracts

This document describes the boundary contracts that CLI handlers use to interact with domain services.

## Overview

The CLI architecture uses domain interfaces as boundaries between the CLI layer and backend implementations. Handlers never access backends directly — they go through these interfaces.

```
CLI Handler → Domain Interface → Backend Implementation
```

## MemoryDomainInterface

Interface for memory operations. CLI handlers use this instead of reading memory storage directly.

```typescript
interface MemoryDomainInterface {
  resolvePreRunContext(request: MemoryResolveRequest): Promise<MemoryResolveResponse>;
  checkAccess(workspace_id, session_id, task_id, intent): Promise<{ available: boolean; reason?: string }>;
  getBackendType(): string;
}
```

### Methods

#### resolvePreRunContext

Resolve memory context before action execution.

**Request:**
```typescript
interface MemoryResolveRequest {
  context_request: MemoryContextRequest;
  search_queries?: string[];
  namespace_filters?: string[];
}
```

**Response:**
```typescript
type MemoryResolveResponse =
  | { success: true; context: PreRunMemoryContext }
  | { success: false; error_code: MemoryResolveErrorCode; reason: string };
```

**Error Codes:**
- `BUDGET_EXCEEDED` — Request exceeded memory budget limits
- `SCOPE_NOT_FOUND` — Requested memory scope does not exist
- `BACKEND_UNAVAILABLE` — Memory backend is not available
- `SEARCH_TIMEOUT` — Memory search exceeded timeout
- `ACCESS_DENIED` — Not authorized for requested memory intent

#### checkAccess

Check if memory access is available for the requested scope and intent.

#### getBackendType

Get the current memory backend type (e.g., "stub", "file", "remote").

## RuntimeDomainContract

Interface for runtime execution. CLI handlers use this instead of executing commands directly.

```typescript
interface RuntimeDomainContract {
  execute(input: RuntimeAcceptedInput): Promise<RuntimeDomainOutput>;
  probeHealth(): Promise<RuntimeHealthProbe>;
  evaluatePolicy(policyContext, dispatchRequest): Promise<PolicyEvaluationResult>;
  getMediationState(): RuntimeMediationState;
  selectBackend(requirements): SandboxBackend;
}
```

### Methods

#### execute

Execute a command through the runtime domain with full mediation.

**Input:**
```typescript
interface RuntimeAcceptedInput {
  dispatch_request: RuntimeDispatchRequest;
  exec_context: {
    command: string;
    args: string[];
    cwd: string;
    env?: Record<string, string>;
    timeout_ms?: number;
  };
}
```

**Output:**
```typescript
type RuntimeDomainOutput = RuntimeSuccessOutput | RuntimeRefusalOutput;
```

#### probeHealth

Probe runtime health without executing any command.

**Response:**
```typescript
interface RuntimeHealthProbe {
  timestamp: string;
  daemon_healthy: boolean;
  sandbox_backend: SandboxBackend;
  sandbox_healthy: boolean;
  active_containers: number;
  resource_usage: { cpu_percent: number; memory_mb: number };
}
```

#### getMediationState

Get current runtime mediation state for diagnostics.

```typescript
interface RuntimeMediationState {
  local_available: boolean;
  container_available: boolean;
  daemon_available: boolean;
  active_sandboxes: number;
  pending_requests: number;
}
```

## OperationsBoundaryContract

Interface for session and task lifecycle operations.

```typescript
interface OperationsBoundaryContract {
  getIdentityFields(): OperationsIdentityFields;
  checkOperationAllowed(operation: LifecycleOperation): OperationsRefusalState;
  getAttachedSessionId(): string | undefined;
  getActiveTaskId(): string | undefined;
  sessionExists(sessionId: string): boolean;
  taskExists(taskId: string): boolean;
}
```

### Methods

#### getIdentityFields

Get current identity context.

```typescript
interface OperationsIdentityFields {
  workspace_id: string;
  session_id?: string;
  task_id?: string;
}
```

#### checkOperationAllowed

Check if a lifecycle operation is allowed in current context.

```typescript
type LifecycleOperation =
  | 'session.create' | 'session.attach' | 'session.detach' | 'session.stop'
  | 'task.create' | 'task.resume' | 'task.suspend' | 'task.stop' | 'task.abort';

interface OperationsRefusalState {
  operation: LifecycleOperation;
  refused: boolean;
  reason?: string;
  can_retry: boolean;
}
```

## OperationsQueryInterface

Read-only query interface for operations data.

```typescript
interface OperationsQueryInterface {
  getSession(sessionId: string): SessionState | null;
  getTask(taskId: string): TaskState | null;
  listSessions(workspaceId: string): SessionState[];
  listTasks(sessionId: string): TaskState[];
}
```

### State Types

```typescript
interface SessionState {
  id: string;
  workspace_id: string;
  is_attached: boolean;
  has_active_task: boolean;
  active_task_id?: string;
  created_at: string;
}

interface TaskState {
  id: string;
  session_id: string;
  workspace_id: string;
  state: 'pending' | 'running' | 'suspended' | 'ready_for_review' | 'merged' | 'aborted';
  created_at: string;
}
```

## Implementation Notes

- All interfaces have stub implementations for bootstrap (`req-13-*-stub.ts`)
- Real implementations replace stubs via dependency injection
- The `DomainProvider` aggregates all domain interfaces
- Access domains via `getDomainProvider()` from `req-13-domain-stubs.ts`
