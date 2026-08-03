/**
 * src/runtime/registry.ts — Runtime profile registry resolver.
 *
 * Owns:
 *   - The catalogue of supported runtime mode identifiers and which of them
 *     have a drafted requirement (selectable in `workbench init sandboxing`).
 *   - Reading `workbench.yaml` `runtimes` + merging each profile's local/
 *     extended settings file when one exists.
 *   - Validating that every configured profile uses a supported mode.
 *   - Writing/replacing a profile (inline entry + optional local settings file).
 *   - Appending runtime configuration events to `.workbench/runtimes/logs/<mode>.jsonl`.
 *
 * Does NOT provision or launch anything — that is a later REQ's scope.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { RuntimeModeId, RuntimeProfileConfig, WorkbenchConfig } from '../types.js';
import {
  resolveRuntimeModeDir,
  resolveRuntimeProfileSettingsPath,
  resolveRuntimesLogsDir,
  resolveRuntimeLogPath,
} from '../config.js';

// ── Supported mode identifiers ───────────────────────────────────────────────

/** Every runtime mode identifier the registry can configure, resolve, and
 *  persist. This is the closed `RuntimeModeId` union — menu-only entries such
 *  as `nvidia-shell` are deliberately NOT members. */
const SUPPORTED_MODE_IDS = new Set<RuntimeModeId>([
  'bare-host',
  'docker-compose',
  'devcontainer',
  'aio-sandbox',
]);

export function isSupportedRuntimeMode(mode: string): mode is RuntimeModeId {
  return (SUPPORTED_MODE_IDS as Set<string>).has(mode);
}

// ── Selection-menu catalogue ─────────────────────────────────────────────────

export interface RuntimeMenuEntry {
  /** Menu identifier. Configurable entries carry a value that is a
   *  `RuntimeModeId`; menu-only entries (e.g. `nvidia-shell`) carry a string
   *  that is intentionally NOT a `RuntimeModeId`, so `isSupportedRuntimeMode`
   *  rejects it and it can never be selected or persisted. */
  id: string;
  label: string;
  /** True only when the entry has both a supported id and a drafted
   *  configuration flow — i.e. it is selectable and configurable. */
  available: boolean;
  /** Shown next to unavailable entries as a distinct "(unavailable)"
   *  decoration; omitted for available entries. */
  unavailableReason?: string;
}

/** Every entry `workbench init sandboxing` renders, in menu order. Decoupled
 *  from the `RuntimeModeId` union on purpose: undrafted modes and planned,
 *  menu-only modes (`nvidia-shell`) appear disabled without widening the set of
 *  selectable/persistable identifiers. Flip `available` to `true` the same day a
 *  mode's REQ lands (only meaningful for entries whose id is a `RuntimeModeId`). */
export const RUNTIME_MENU: RuntimeMenuEntry[] = [
  { id: 'bare-host', label: 'Bare Host', available: true },
  { id: 'docker-compose', label: 'Docker Compose', available: true },
  { id: 'devcontainer', label: 'Devcontainer', available: false, unavailableReason: 'not yet drafted' },
  { id: 'aio-sandbox', label: 'AIO Sandbox', available: false, unavailableReason: 'not yet drafted' },
  { id: 'nvidia-shell', label: 'NVIDIA Shell', available: false, unavailableReason: 'planned — menu only' },
];

export class UnsupportedRuntimeModeError extends Error {
  constructor(public profileName: string, public mode: string) {
    super(`Runtime profile "${profileName}" declares unsupported runtime mode "${mode}".`);
    this.name = 'UnsupportedRuntimeModeError';
  }
}

// ── Resolved profile shape ──────────────────────────────────────────────────────

export interface ResolvedRuntimeProfile {
  name: string;
  mode: RuntimeModeId;
  label: string;
  /** Inline settings merged with the local/extended settings file, if any. */
  settings: Record<string, unknown>;
}

/**
 * Merge the inline profile entry in `workbench.yaml` with its local/extended
 * settings file at `.workbench/runtimes/<mode>/<profile>.yaml`, when present.
 * Local settings win on key collision (they are the mode's own extended data).
 */
export function resolveRuntimeProfile(config: WorkbenchConfig, profileName: string): ResolvedRuntimeProfile {
  const entry = config.runtimes[profileName];
  if (!entry) {
    throw new Error(`Runtime profile "${profileName}" is not configured in workbench.yaml.`);
  }
  if (!isSupportedRuntimeMode(entry.mode)) {
    throw new UnsupportedRuntimeModeError(profileName, entry.mode);
  }

  let local: Record<string, unknown> = {};
  const localPath = entry.settingsRef
    ? path.resolve(process.cwd(), entry.settingsRef)
    : resolveRuntimeProfileSettingsPath(entry.mode, profileName);

  if (fs.existsSync(localPath)) {
    const raw = fs.readFileSync(localPath, 'utf-8');
    local = (parseYaml(raw) as Record<string, unknown>) ?? {};
  }

  return {
    name: profileName,
    mode: entry.mode,
    label: entry.label,
    settings: { ...entry.settings, ...local },
  };
}

/**
 * Read `workbench.yaml`, return every configured runtime profile, and reject
 * (by throwing) the first one whose mode identifier is unsupported — naming
 * the profile and the rejected identifier. Consumed by `workbench session create`.
 */
export function listRuntimeProfiles(config: WorkbenchConfig): ResolvedRuntimeProfile[] {
  return Object.keys(config.runtimes).map((name) => resolveRuntimeProfile(config, name));
}

// ── Writing / replacing a profile ───────────────────────────────────────────────

export interface WriteProfileInput {
  profileName: string;
  mode: RuntimeModeId;
  label: string;
  /** Settings the mode declared shareable — written inline in workbench.yaml. */
  inlineSettings: Record<string, unknown>;
  /** Settings the mode declared local/extended — written to the per-mode
   *  settings file. Omit (or pass `{}`) for modes with no local settings. */
  localSettings?: Record<string, unknown>;
}

/**
 * Write (or fully replace) one runtime profile: the inline `workbench.yaml`
 * entry, plus its local/extended settings file when `localSettings` is given.
 * Returns the config object with `runtimes[profileName]` set — callers persist
 * it via `writeConfig()` from `src/config.ts`.
 */
export function writeRuntimeProfile(config: WorkbenchConfig, input: WriteProfileInput): WorkbenchConfig {
  const hasLocal = input.localSettings && Object.keys(input.localSettings).length > 0;
  const settingsRef = hasLocal
    ? path.relative(process.cwd(), resolveRuntimeProfileSettingsPath(input.mode, input.profileName))
    : undefined;

  if (hasLocal) {
    const dir = resolveRuntimeModeDir(input.mode);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      resolveRuntimeProfileSettingsPath(input.mode, input.profileName),
      stringifyYaml(input.localSettings, { indent: 2 }),
      'utf-8',
    );
  }

  const entry: RuntimeProfileConfig = {
    mode: input.mode,
    label: input.label,
    settings: input.inlineSettings,
    ...(settingsRef ? { settingsRef } : {}),
  };

  return {
    ...config,
    runtimes: { ...config.runtimes, [input.profileName]: entry },
  };
}

// ── Configuration event log ─────────────────────────────────────────────────────

export interface RuntimeConfigEvent {
  profileName: string;
  mode: RuntimeModeId;
  probeResult: 'passed' | 'failed' | 'skipped';
  overwrite: boolean;
  outcome: 'configured' | 'aborted' | 'failed';
  /** Mode-specific extra fields (e.g. composeFile/service for docker-compose). */
  detail?: Record<string, unknown>;
}

/**
 * Append one JSON Lines event to `.workbench/runtimes/logs/<mode>.jsonl`,
 * creating `.workbench/runtimes/logs/` first if it does not exist.
 */
export function appendRuntimeConfigEvent(event: RuntimeConfigEvent): void {
  fs.mkdirSync(resolveRuntimesLogsDir(), { recursive: true });
  const record = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...event,
  };
  fs.appendFileSync(resolveRuntimeLogPath(event.mode), JSON.stringify(record) + '\n', 'utf-8');
}
