/**
 * Memory plugin registry — decides the active plugin from config, defaulting to the built-in
 * `.this` layer. This is the single place that resolves a `MemoryPlugin`; all services take a
 * `MemoryPlugin` and never branch on plugin name.
 */

import type { MemoryPlugin } from './interface.js';
import type { WorkbenchConfig } from '../types.js';
import { loadConfig } from '../config.js';

/** Lazy loaders. The built-in `.this` layer ships as the default; OpenViking is opt-in. */
const adapters: Record<string, () => Promise<new (...args: any[]) => MemoryPlugin>> = {
  filesystem: () => import('./adapters/filesystem.js').then((m) => m.FilesystemPlugin),
  openviking: () => import('./adapters/openviking.js').then((m) => m.OpenVikingPlugin),
};

/** The built-in default. Named 'filesystem' — the `.this` layer. */
export const DEFAULT_PLUGIN = 'filesystem';

/**
 * Resolve the active memory plugin from config, defaulting to the built-in `.this` layer.
 * If the configured plugin is unknown, inactive, or fails its health/capability test,
 * fall back to the built-in `.this` layer so memory always works.
 *
 * `config` is optional — when omitted the current workspace config is loaded. Consumers that
 * already hold a `WorkbenchConfig` (e.g. the operations docs hook) can pass it directly.
 */
export async function resolveMemoryPlugin(config?: WorkbenchConfig): Promise<MemoryPlugin> {
  const cfg = config ?? loadConfig();
  // `memory` is typed on WorkbenchConfig as `memory?: { plugin?: string }` (architecture
  // file-first LLD). The optional-chained access below type-checks against that exact shape.
  const requested = cfg.memory?.plugin ?? DEFAULT_PLUGIN;

  const fallback = await instantiate(DEFAULT_PLUGIN);
  if (requested === DEFAULT_PLUGIN) return fallback;

  const loader = adapters[requested];
  if (!loader) return fallback; // unknown plugin → built-in

  try {
    const plugin = await instantiate(requested);
    const report = await plugin.backendTest();
    if (!report.healthy) return fallback; // unhealthy → built-in
    return plugin;
  } catch {
    return fallback; // instantiation error → built-in
  }
}

async function instantiate(name: string): Promise<MemoryPlugin> {
  const loader = adapters[name];
  if (!loader) throw new Error(`Unknown memory plugin: ${name}`);
  const Ctor = await loader();
  return new Ctor();
}
