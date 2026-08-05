/**
 * Configuration loader for workbench.yaml
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import type { WorkbenchConfig, PreviewGCPolicy, PortAllocatorConfig, RuntimeModeId } from './types.js';

// ── Global config types (~/.workbench.toml) ────────────────────────────────────

export interface GlobalAgents {
  openai_api_key?: string;
  anthropic_api_key?: string;
  github_token?: string;
  ollama_url?: string;
}

export interface GlobalMemory {
  backend?: string;
  openviking_url?: string;
  openviking_mode?: string;
  openviking_api_key?: string;
  openviking_workspace?: string;
}

export interface DeploymentCoolify {
  url?: string;
  token?: string;
  project_uuid?: string;
  server_uuid?: string;
  environment_name?: string;
  git_repository?: string;
}

export interface DeploymentNetlify {
  token?: string;
  site_id?: string;
}

export interface DeploymentCloudflare {
  api_token?: string;
  account_id?: string;
}

export interface GlobalDeployments {
  coolify?: DeploymentCoolify;
  netlify?: DeploymentNetlify;
  cloudflare?: DeploymentCloudflare;
}

export interface GlobalDocs {
  preset?: 'openai' | 'ollama' | 'lm-studio';
  embedding_model?: string;
  api_base?: string;
}

export interface WorkbenchGlobalConfig {
  agents?: GlobalAgents;
  memory?: GlobalMemory;
  deployments?: GlobalDeployments;
  docs?: GlobalDocs;
}

const CONFIG_FILENAME = 'workbench.yaml';

const DEFAULT_GC_POLICY: PreviewGCPolicy = {
  afterMergeDelayMs: 3_600_000,
  suspendTtlMs: 259_200_000,
  idleTtlMs: 604_800_000,
  idleGracePeriodMs: 86_400_000,
  maxActivePerWorkspace: 10,
};

const DEFAULT_PORTS: PortAllocatorConfig = {
  enabled: true,
  range: [10_000, 10_999],
  reserve: [],
  strategy: 'sequential',
  staleTtl: 3600,
};

export const DEFAULT_CONFIG: WorkbenchConfig = {
  version: '1',
  workspace: {
    id: '',
    name: '',
  },
  runtime: {
    mode: 'daemon-managed',
  },
  runtimes: {
    'bare-host': {
      mode: 'bare-host',
      label: 'Bare Host',
      settings: {},
    },
  },
  default_runtime: 'bare-host',
  preview: {
    default: 'coolify',
    rules: [],
    gc: DEFAULT_GC_POLICY,
  },
  ports: DEFAULT_PORTS,
  secrets: {
    backend: 'file',
    providerAllowlists: {},
    requireTmpfsInDevManaged: true,
  },
  agents: {
    providers: [
      { name: 'claude', enabled: true, mcpEnabled: true },
      { name: 'codex', enabled: true, mcpEnabled: false },
      { name: 'copilot', enabled: false, mcpEnabled: false },
    ],
  },
  memory: {},
  diagrams: {
    previewPort: 5678,
  },
};

export function findConfigPath(startDir?: string): string | null {
  let dir = startDir ?? process.cwd();
  while (true) {
    const candidate = path.join(dir, CONFIG_FILENAME);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadConfig(configPath?: string): WorkbenchConfig {
  const resolved = configPath ?? findConfigPath();
  if (!resolved || !fs.existsSync(resolved)) {
    return { ...DEFAULT_CONFIG };
  }

  const raw = fs.readFileSync(resolved, 'utf-8');
  const parsed = parseYaml(raw) as Partial<WorkbenchConfig>;

  return mergeConfig(DEFAULT_CONFIG, parsed);
}

export function writeConfig(config: WorkbenchConfig, configPath?: string): void {
  const resolved = configPath ?? path.join(process.cwd(), CONFIG_FILENAME);
  const yaml = stringifyYaml(config, { indent: 2 });
  fs.writeFileSync(resolved, yaml, 'utf-8');
}

function mergeConfig(defaults: WorkbenchConfig, overrides: Partial<WorkbenchConfig>): WorkbenchConfig {
  return {
    version: overrides.version ?? defaults.version,
    workspace: { ...defaults.workspace, ...overrides.workspace },
    runtime: { ...defaults.runtime, ...overrides.runtime },
    runtimes: { ...defaults.runtimes, ...overrides.runtimes },
    default_runtime: overrides.default_runtime ?? defaults.default_runtime,
    preview: {
      ...defaults.preview,
      ...overrides.preview,
      gc: { ...defaults.preview.gc, ...overrides.preview?.gc },
    },
    ports: { ...defaults.ports, ...overrides.ports } as PortAllocatorConfig,
    secrets: { ...defaults.secrets, ...overrides.secrets },
    agents: {
      providers: overrides.agents?.providers ?? defaults.agents.providers,
    },
    memory: { ...defaults.memory, ...overrides.memory },
    diagrams: { ...defaults.diagrams, ...overrides.diagrams },
  };
}

// ---------------------------------------------------------------------------
// Global settings (~/.workbench/config.yaml) + docs embedding presets
// ---------------------------------------------------------------------------

/** @deprecated Use GlobalDocs from WorkbenchGlobalConfig instead */
export interface DocsEmbeddingSettings {
  preset: 'openai' | 'ollama' | 'lm-studio';
  embeddingModel: string;
  apiBase?: string;
}

export function loadGlobalConfig(): WorkbenchGlobalConfig {
  const p = resolveGlobalConfigPath();
  if (!fs.existsSync(p)) return {};
  try {
    return parseToml(fs.readFileSync(p, 'utf-8')) as WorkbenchGlobalConfig;
  } catch {
    return {};
  }
}

export function writeGlobalConfig(config: WorkbenchGlobalConfig): void {
  const p = resolveGlobalConfigPath();
  fs.writeFileSync(p, stringifyToml(config as Record<string, unknown>), { mode: 0o600 });
}

export type DocsEmbeddingPreset = 'openai' | 'ollama' | 'lm-studio';

const PRESET_DEFAULTS: Record<DocsEmbeddingPreset, { model?: string; apiBase?: string }> = {
  openai: { model: 'text-embedding-3-small' },
  ollama: { apiBase: 'http://localhost:11434/v1' },
  'lm-studio': { apiBase: 'http://localhost:1234/v1' },
};

/** Default embedding model name for a preset, or undefined when the user must supply one
 *  (ollama/lm-studio have no universal default model — it depends on what's pulled locally). */
export function defaultEmbeddingModelFor(preset: DocsEmbeddingPreset): string | undefined {
  return PRESET_DEFAULTS[preset].model;
}

/** Default OpenAI-compatible base URL for a preset, or undefined for the `openai` preset itself. */
export function defaultApiBaseFor(preset: DocsEmbeddingPreset): string | undefined {
  return PRESET_DEFAULTS[preset].apiBase;
}

/** Resolve a preset + model name into the DOCS_MCP_EMBEDDING_MODEL / OPENAI_API_BASE pair
 *  expected by @arabold/docs-mcp-server. All three presets use the `openai:<model>` identifier —
 *  ollama and lm-studio are consumed through docs-mcp-server's OpenAI-compatible path. */
export function resolveEmbeddingPreset(
  preset: DocsEmbeddingPreset,
  modelName: string,
): { embeddingModel: string; apiBase?: string } {
  return {
    embeddingModel: `openai:${modelName}`,
    apiBase: defaultApiBaseFor(preset),
  };
}

/** Global config file (~/.workbench.toml). */
export function resolveGlobalConfigPath(): string {
  return process.env.WORKBENCH_CONFIG_PATH ?? path.join(process.env.HOME ?? '', '.workbench.toml');
}

/**
 * Load credentials from ~/.workbench.toml into process.env.
 * Maps TOML structure to environment variables expected by the codebase.
 */
export function loadCredentials(): void {
  const configPath = resolveGlobalConfigPath();
  if (!fs.existsSync(configPath)) return;

  // Warn on permissive permissions
  try {
    const mode = fs.statSync(configPath).mode & 0o777;
    if (mode & 0o077) {
      process.stderr.write(`warning: ${configPath} has permissive mode ${mode.toString(8)}; run \`chmod 600 ${configPath}\` to secure it\n`);
    }
  } catch { /* ignore */ }

  const config = loadGlobalConfig();

  // [agents] → env vars
  if (config.agents?.openai_api_key && !process.env.OPENAI_API_KEY) {
    process.env.OPENAI_API_KEY = config.agents.openai_api_key;
  }
  if (config.agents?.anthropic_api_key && !process.env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = config.agents.anthropic_api_key;
  }
  if (config.agents?.github_token && !process.env.GITHUB_TOKEN) {
    process.env.GITHUB_TOKEN = config.agents.github_token;
  }
  if (config.agents?.ollama_url && !process.env.WORKBENCH_OLLAMA_URL) {
    process.env.WORKBENCH_OLLAMA_URL = config.agents.ollama_url;
  }

  // [memory] → env vars
  if (config.memory?.backend && !process.env.WORKBENCH_MEMORY_BACKEND) {
    process.env.WORKBENCH_MEMORY_BACKEND = config.memory.backend;
  }
  if (config.memory?.openviking_url && !process.env.WORKBENCH_OPENVIKING_URL) {
    process.env.WORKBENCH_OPENVIKING_URL = config.memory.openviking_url;
  }
  if (config.memory?.openviking_mode && !process.env.WORKBENCH_OPENVIKING_MODE) {
    process.env.WORKBENCH_OPENVIKING_MODE = config.memory.openviking_mode;
  }
  if (config.memory?.openviking_api_key && !process.env.WORKBENCH_OPENVIKING_API_KEY) {
    process.env.WORKBENCH_OPENVIKING_API_KEY = config.memory.openviking_api_key;
  }
  if (config.memory?.openviking_workspace && !process.env.WORKBENCH_OPENVIKING_WORKSPACE) {
    process.env.WORKBENCH_OPENVIKING_WORKSPACE = config.memory.openviking_workspace;
  }

  // [deployments.coolify] → env vars
  if (config.deployments?.coolify?.url && !process.env.WORKBENCH_COOLIFY_URL) {
    process.env.WORKBENCH_COOLIFY_URL = config.deployments.coolify.url;
  }
  if (config.deployments?.coolify?.token && !process.env.WORKBENCH_COOLIFY_TOKEN) {
    process.env.WORKBENCH_COOLIFY_TOKEN = config.deployments.coolify.token;
  }
  if (config.deployments?.coolify?.project_uuid && !process.env.WORKBENCH_COOLIFY_PROJECT_UUID) {
    process.env.WORKBENCH_COOLIFY_PROJECT_UUID = config.deployments.coolify.project_uuid;
  }
  if (config.deployments?.coolify?.server_uuid && !process.env.WORKBENCH_COOLIFY_SERVER_UUID) {
    process.env.WORKBENCH_COOLIFY_SERVER_UUID = config.deployments.coolify.server_uuid;
  }
  if (config.deployments?.coolify?.environment_name && !process.env.WORKBENCH_COOLIFY_ENVIRONMENT_NAME) {
    process.env.WORKBENCH_COOLIFY_ENVIRONMENT_NAME = config.deployments.coolify.environment_name;
  }
  if (config.deployments?.coolify?.git_repository && !process.env.WORKBENCH_COOLIFY_GIT_REPOSITORY) {
    process.env.WORKBENCH_COOLIFY_GIT_REPOSITORY = config.deployments.coolify.git_repository;
  }

  // [deployments.netlify] → env vars
  if (config.deployments?.netlify?.token && !process.env.WORKBENCH_NETLIFY_TOKEN) {
    process.env.WORKBENCH_NETLIFY_TOKEN = config.deployments.netlify.token;
  }
  if (config.deployments?.netlify?.site_id && !process.env.WORKBENCH_NETLIFY_SITE_ID) {
    process.env.WORKBENCH_NETLIFY_SITE_ID = config.deployments.netlify.site_id;
  }

  // [deployments.cloudflare] → env vars
  if (config.deployments?.cloudflare?.api_token && !process.env.WORKBENCH_CLOUDFLARE_API_TOKEN) {
    process.env.WORKBENCH_CLOUDFLARE_API_TOKEN = config.deployments.cloudflare.api_token;
  }
  if (config.deployments?.cloudflare?.account_id && !process.env.WORKBENCH_CLOUDFLARE_ACCOUNT_ID) {
    process.env.WORKBENCH_CLOUDFLARE_ACCOUNT_ID = config.deployments.cloudflare.account_id;
  }
}

/** Root of the local .workbench state tree relative to cwd. */
export function resolveWorkbenchDir(): string {
  return process.env.WORKBENCH_DIR ?? path.join(process.cwd(), '.workbench');
}

/** Root of the .workbench/memory directory. */
export function resolveMemoryRoot(): string {
  return process.env.WORKBENCH_MEMORY_ROOT ?? path.join(resolveWorkbenchDir(), 'memory');
}

/** File-first local memory root (.workbench/memory/.this). */
export function resolveMemoryThisDir(): string {
  return path.join(resolveMemoryRoot(), '.this');
}

/**
 * Canonical task/session store of record — dated journals under the local
 * memory tree (.workbench/memory/.this/journals). Records live at
 * `journals/<YYYY_MM_DD>/<task-id>/`; this resolver returns the journals root.
 */
export function resolveJournalsDir(): string {
  return process.env.WORKBENCH_JOURNALS_DIR ?? path.join(resolveMemoryThisDir(), 'journals');
}

/** Placeholder for scoped secret manifests (.workbench/secrets). */
export function resolveSecretsDir(): string {
  return process.env.WORKBENCH_SECRETS_DIR ?? path.join(resolveWorkbenchDir(), 'secrets');
}

/** Shared indexed-docs knowledge base — docs-mcp-server store (.workbench/memory/.this/resources/docs). */
export function resolveDocsMcpDataDir(): string {
  return process.env.WORKBENCH_DOCS_MCP_DATA_DIR ?? path.join(resolveMemoryThisDir(), 'resources', 'docs');
}

/** OpenViking workspace directory (.workbench/memory/openviking). */
export function resolveOpenVikingWorkspace(): string {
  return process.env.WORKBENCH_OPENVIKING_WORKSPACE ?? path.join(resolveMemoryRoot(), 'openviking');
}

/** Runtime profiles tree (.workbench/runtimes). */
export function resolveRuntimesDir(): string {
  return process.env.WORKBENCH_RUNTIMES_DIR ?? path.join(resolveWorkbenchDir(), 'runtimes');
}

/** Runtime profile event logs (.workbench/runtimes/logs). */
export function resolveRuntimesLogsDir(): string {
  return path.join(resolveRuntimesDir(), 'logs');
}

/** Per-mode directory holding local/extended profile settings (.workbench/runtimes/<mode>). */
export function resolveRuntimeModeDir(mode: RuntimeModeId): string {
  return path.join(resolveRuntimesDir(), mode);
}

/** Local/extended settings file for one profile (.workbench/runtimes/<mode>/<profile>.yaml). */
export function resolveRuntimeProfileSettingsPath(mode: RuntimeModeId, profileName: string): string {
  return path.join(resolveRuntimeModeDir(mode), `${profileName}.yaml`);
}

/** JSON Lines event log for one runtime mode (.workbench/runtimes/logs/<mode>.jsonl). */
export function resolveRuntimeLogPath(mode: RuntimeModeId): string {
  return path.join(resolveRuntimesLogsDir(), `${mode}.jsonl`);
}

/** Append-only preview deployment event log (.workbench/previews.jsonl). */
export function resolvePreviewsLog(): string {
  return path.join(resolveWorkbenchDir(), 'previews.jsonl');
}

/** Append-only port-lease event log (.workbench/leases.jsonl). */
export function resolveLeasesLog(): string {
  return path.join(resolveWorkbenchDir(), 'leases.jsonl');
}

/** Append-only audit event log (.workbench/audit.jsonl). */
export function resolveAuditLog(): string {
  return path.join(resolveWorkbenchDir(), 'audit.jsonl');
}
