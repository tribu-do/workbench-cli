/**
 * Workbench — AI-first sandboxed agentic development.
 *
 * Public API for programmatic usage.
 *
 * @license MIT
 * @author Richard Blondet, Claude (Anthropic), Codex (OpenAI)
 */

// Core types
export type {
  Scope,
  ScopeContext,
  RuntimeMode,
  IsolationTier,
  Session,
  SessionState,
  TaskState,
  TaskSpec,
  Task,
  TaskEvent,
  PortSpec,
  PortRequest,
  PortLease,
  PortAllocatorConfig,
  PolicyVerdict,
  RuntimeProbe,
  ExecRequest,
  ExecResult,
  ExecLogEntry,
  SecretMeta,
  SecretPolicyVerdict,
  SecretAuditEntry,
  ResolvedSecretSet,
  DeploymentProviderName,
  DeploymentKind,
  PreviewInput,
  PreviewHandle,
  PreviewStatus,
  PreviewGCPolicy,
  MemoryRecord,
  ResolvedManifest,
  SkillManifest,
  McpServerManifest,
  WorkbenchConfig,
  PreviewRule,
  AgentProviderConfig,
} from './types.js';

// Core services
export { loadConfig, writeConfig, loadCredentials, resolveGlobalConfigPath, findConfigPath, DEFAULT_CONFIG } from './config.js';
export { Orchestrator, OrchestratorError } from './orchestrator.js';
export { PolicyEngine, PolicyError } from './policy-engine.js';
export { SandboxBroker } from './sandbox-broker.js';
export { PortAllocator, PortAllocationError } from './port-allocator.js';
export { SecretManager, SecretPolicy } from './secret-manager.js';

// Memory
export { MemoryService } from './memory/service.js';

// Skills
export { SkillsRegistry } from './skills/registry.js';

// Sessions
export { SessionService } from './sessions/service.js';

// Runtime
export { DockerRuntime, DockerError } from './runtime/docker.js';
export { createWorktree, removeWorktree, findRepoRoot, isGitRepo, WorktreeError } from './runtime/worktree.js';

// Agents
export type { AgentProvider, AgentLaunchSpec, AgentSession } from './agents/types.js';
export { ClaudeProvider } from './agents/claude.js';

// Deployment
export type { DeploymentProvider } from './deployment/types.js';
export { CoolifyPreviewProvider } from './deployment/coolify.js';
export { NetlifyProvider } from './deployment/netlify.js';
export { CloudflareProvider } from './deployment/cloudflare.js';

// CLI context
export { createWorkbench } from './cli/context.js';
export type { WorkbenchContext } from './cli/context.js';
