/**
 * Core types for the Workbench system.
 * Derived from the architecture plan (LLD-1 through LLD-5.1).
 */

// ---------------------------------------------------------------------------
// Scopes & Identifiers
// ---------------------------------------------------------------------------

export type Scope = 'global' | 'workspace' | 'session' | 'task';

export interface ScopeContext {
  workspaceId?: string;
  sessionId?: string;
  taskId?: string;
}

// ---------------------------------------------------------------------------
// Runtime Modes (§3.2)
// ---------------------------------------------------------------------------

export type RuntimeMode = 'daemon-managed' | 'dev-managed' | 'bare-host';
export type IsolationTier = 'strong' | 'medium' | 'weak' | 'strong+gpu';

// ---------------------------------------------------------------------------
// Runtime Profile Registry (runtime domain — req-runtime-profile-registry)
// ---------------------------------------------------------------------------

/** Supported runtime mode identifiers. Stable values: CLI selection output and
 *  the persisted `runtimeMode` field on the task-shaped journal record both
 *  use these exact strings — do not rename without a migration. */
export type RuntimeModeId = 'bare-host' | 'docker-compose' | 'devcontainer' | 'aio-sandbox';

/** One configured runtime profile, keyed by profile name in `WorkbenchConfig.runtimes`.
 *  `settings` holds only the settings a runtime mode declares shareable — those are
 *  written inline in `workbench.yaml`. Settings a mode declares local/extended are
 *  written to `.workbench/runtimes/<mode>/<profile>.yaml` and referenced here via
 *  `settingsRef` (a path relative to the workspace root). */
export interface RuntimeProfileConfig {
  mode: RuntimeModeId;
  label: string;
  settings: Record<string, unknown>;
  settingsRef?: string;
}

// ---------------------------------------------------------------------------
// Session (first-class working unit; many tasks per session)
// ---------------------------------------------------------------------------

export type SessionState = 'active' | 'paused' | 'ended';

export interface Session {
  id: string;
  workspaceId: string;
  name: string;
  state: SessionState;
  runtimeMode: RuntimeMode;
  /** Agent CLI that executes tasks in this session. */
  agent: 'claude' | 'codex' | 'copilot';
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
}

// ---------------------------------------------------------------------------
// Task Lifecycle (LLD-1)
// ---------------------------------------------------------------------------

export type TaskState =
  | 'pending'
  | 'provisioning_runtime'
  | 'running'
  | 'downgraded'
  | 'suspended'
  | 'ready_for_review'
  | 'merged'
  | 'aborted';

export interface PortSpec {
  name: string;
  port?: number;
  protocol?: 'tcp' | 'udp';
  expose?: boolean;
}

export interface TaskSpec {
  id?: string;
  name: string;
  branch?: string;
  workspaceId?: string;
  sessionId?: string;
  runtimeMode?: RuntimeMode;
  composeFile?: string;
  sshTarget?: string;
  aiAgentProvider?: 'claude' | 'codex' | 'copilot';
  autoApprove?: boolean;
  ports?: number | number[] | PortSpec[];
  secrets?: string[];
  deployProvider?: 'coolify' | 'netlify' | 'cloudflare';
  metadata?: Record<string, unknown>;
}

export interface Task {
  id: string;
  name: string;
  branch: string;
  workspaceId: string;
  sessionId: string;
  state: TaskState;
  runtimeMode: RuntimeMode;
  isolationTier: IsolationTier;
  aiAgentProvider: string;
  autoApprove: boolean;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  kind: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Port Management (file-first — append-only .workbench/leases.jsonl)
// ---------------------------------------------------------------------------

export interface PortRequest {
  name: string;
  port?: number;
  protocol?: 'tcp' | 'udp';
}

/** One line of `.workbench/leases.jsonl`. */
export interface PortLeaseEvent {
  id: string;
  timestamp: string;
  event: 'reserve' | 'release';
  workspaceId: string;
  sessionId: string;
  name: string;
  port: number;
  protocol: 'tcp' | 'udp';
}

/** A currently-active (reserved, not yet released) lease — derived by replaying the log. */
export interface PortLease {
  workspaceId: string;
  sessionId: string;
  name: string;
  port: number;
  protocol: 'tcp' | 'udp';
  reservedAt: string;
}

export interface PortAllocatorConfig {
  enabled: boolean;
  range: [number, number];
  reserve: number[];
  strategy: 'sequential' | 'random';
  staleTtl: number;
}

// ---------------------------------------------------------------------------
// Secret Management (LLD-5.1)
// ---------------------------------------------------------------------------

export interface SecretMeta {
  description?: string;
  rotatedAt?: string;
}

export interface ResolvedSecretSet {
  secrets: Map<string, string>;
  scope: Scope;
  taskId: string;
}

export interface SecretPolicyVerdict {
  enforceable: boolean;
  injectionMethod: 'env-sealed' | 'tmpfs-file' | 'unenforceable';
  deniedKeys: string[];
  reasons: string[];
}

export interface SecretAuditEntry {
  id: string;
  timestamp: string;
  action: 'resolve' | 'inject' | 'rotate' | 'revoke';
  scope: Scope;
  key: string;
  taskId: string;
  provider: string;
  runtimeMode: RuntimeMode;
  verdict: string;
}

// ---------------------------------------------------------------------------
// Policy Engine (LLD-5)
// ---------------------------------------------------------------------------

export interface RuntimeProbe {
  runtimeMode: RuntimeMode;
  aioHealthy: boolean;
  dockerHealthy: boolean;
  shimHealthy: boolean;
  ptyWrapHealthy: boolean;
  gpuAvailable: boolean;
}

export interface PolicyVerdict {
  effectiveAutoApprove: boolean;
  isolationTier: IsolationTier;
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Sandbox Broker (LLD-5)
// ---------------------------------------------------------------------------

export interface ExecRequest {
  taskId: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeout?: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  blocked: boolean;
  durationMs: number;
}

export interface ExecLogEntry {
  id: string;
  taskId: string;
  command: string;
  exitCode: number;
  blocked: boolean;
  runtimeMode: RuntimeMode;
  isolationTier: IsolationTier;
  durationMs: number;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Deployment (LLD-3)
// ---------------------------------------------------------------------------

export type DeploymentProviderName = 'coolify' | 'netlify' | 'cloudflare';
export type DeploymentKind = 'full-stack' | 'static' | 'edge';

export interface PreviewInput {
  taskId: string;
  workspaceId: string;
  branch: string;
  buildCommand?: string;
  outputDir?: string;
  envVars?: Record<string, string>;
  ports?: PortLease[];
}

export interface PreviewHandle {
  id: string;
  provider: DeploymentProviderName;
  url: string;
  status: PreviewStatus;
  createdAt: string;
}

export type PreviewStatus = 'building' | 'deploying' | 'ready' | 'failed' | 'destroyed';

export interface PreviewGCPolicy {
  afterMergeDelayMs: number;
  suspendTtlMs: number;
  idleTtlMs: number;
  idleGracePeriodMs: number;
  maxActivePerWorkspace: number;
}

// ---------------------------------------------------------------------------
// Memory (LLD-2)
// ---------------------------------------------------------------------------

export interface MemoryRecord {
  id: string;
  scope: Scope;
  scopeId: string;
  namespace: string;
  key: string;
  body: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ResolvedManifest {
  id: string;
  kind: 'skill' | 'mcp';
  scope: Scope;
  scopeId: string;
  manifest: Record<string, unknown>;
  provenance?: string;
}

// ---------------------------------------------------------------------------
// Skills & MCP (LLD-2 + LLD-4)
// ---------------------------------------------------------------------------

export interface SkillManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  provider?: string;
  entrypoint?: string;
  config?: Record<string, unknown>;
}

export interface McpServerManifest {
  id: string;
  name: string;
  description: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
  command?: string;
  args?: string[];
  url?: string;
  config?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Configuration (workbench.yaml)
// ---------------------------------------------------------------------------

export interface WorkbenchConfig {
  version: string;
  workspace: {
    id: string;
    name: string;
  };
  runtime: {
    mode: RuntimeMode;
    composeFile?: string;
    sshTarget?: string;
  };
  /** Runtime profile registry, keyed by profile name. Always contains at least
   *  the `bare-host` key. */
  runtimes: Record<string, RuntimeProfileConfig>;
  /** Profile name from `runtimes` that `workbench session create` offers first. */
  default_runtime: string;
  preview: {
    default: DeploymentProviderName;
    rules: PreviewRule[];
    gc: PreviewGCPolicy;
  };
  ports: PortAllocatorConfig;
  secrets: {
    backend: 'file' | 'vault' | 'aws-sm';
    providerAllowlists: Record<string, string[]>;
    requireTmpfsInDevManaged: boolean;
  };
  agents: {
    providers: AgentProviderConfig[];
  };
  /** Memory context store selection. */
  memory?: {
    plugin?: string;
  };
  diagrams: {
    previewPort: number;
  };
}

export interface PreviewRule {
  when: string;
  provider: DeploymentProviderName;
}

export interface AgentProviderConfig {
  name: 'claude' | 'codex' | 'copilot';
  enabled: boolean;
  shellOverride?: string;
  mcpEnabled?: boolean;
}
