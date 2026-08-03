/**
 * Configuration loader for workbench.yaml
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { WorkbenchConfig, PreviewGCPolicy, PortAllocatorConfig, RuntimeModeId } from './types.js';

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

export interface DocsEmbeddingSettings {
  preset: 'openai' | 'ollama' | 'lm-studio';
  /** DOCS_MCP_EMBEDDING_MODEL value, e.g. "openai:text-embedding-3-small". */
  embeddingModel: string;
  /** OPENAI_API_BASE value; omitted for the `openai` preset (uses OpenAI's default endpoint). */
  apiBase?: string;
}

export interface WorkbenchGlobalConfig {
  docs?: DocsEmbeddingSettings;
}

export function loadGlobalConfig(): WorkbenchGlobalConfig {
  const p = resolveGlobalConfigPath();
  if (!fs.existsSync(p)) return {};
  try {
    return (parseYaml(fs.readFileSync(p, 'utf-8')) as WorkbenchGlobalConfig) ?? {};
  } catch {
    return {};
  }
}

export function writeGlobalConfig(config: WorkbenchGlobalConfig): void {
  const p = resolveGlobalConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, stringifyYaml(config, { indent: 2 }), 'utf-8');
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

/**
 * Load credentials from ~/.workbench (or WORKBENCH_CREDENTIALS_PATH).
 * Returns a record of WORKBENCH_* env vars found.
 * Does NOT read the file values into memory beyond what's needed —
 * values are set directly into process.env.
 */
export function loadCredentials(): void {
  const credPath = resolveCredentialsPath();
  if (!fs.existsSync(credPath)) return;

  // Warn on permissive permissions
  try {
    const mode = fs.statSync(credPath).mode & 0o777;
    if (mode & 0o077) {
      process.stderr.write(`warning: ${credPath} has permissive mode ${mode.toString(8)}; consider \`chmod 600 ${credPath}\`\n`);
    }
  } catch { /* ignore */ }

  const lines = fs.readFileSync(credPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^export\s+(\w+)=["']?(.+?)["']?\s*$/);
    if (match) {
      const [, key, value] = match;
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }
}

/** Global settings directory (~/.workbench). */
export function resolveGlobalDir(): string {
  return process.env.WORKBENCH_GLOBAL_DIR ?? path.join(process.env.HOME ?? '', '.workbench');
}

/** Credentials file inside the global settings directory (~/.workbench/credentials). */
export function resolveCredentialsPath(): string {
  return process.env.WORKBENCH_CREDENTIALS_PATH ?? path.join(resolveGlobalDir(), 'credentials');
}

/** Global settings manifest (~/.workbench/config.yaml). */
export function resolveGlobalConfigPath(): string {
  return path.join(resolveGlobalDir(), 'config.yaml');
}

export const CREDENTIALS_PATH = resolveCredentialsPath();

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
