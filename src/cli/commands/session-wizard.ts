/**
 * src/cli/commands/session-wizard.ts — Interactive `workbench session create` wizard.
 *
 * Collects every answer needed to persist a draft session record. Performs no I/O beyond
 * read-only discovery (globbing REQ files, listing memory subtrees, reading workbench.yaml,
 * reading the port lease log, checking process.env for configured secrets). Never writes a
 * session record — that is the caller's responsibility (see sessions/store.ts).
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { glob } from 'glob';
import { parse as parseYaml } from 'yaml';
import { findConfigPath, resolveMemoryThisDir, resolveWorkbenchDir } from '../../config.js';
import { requiredSecretsFor } from '../../runtime/launch.js';
import type { SecretSelection } from '../../sessions/store.js';
import type { WorkbenchContext } from '../context.js';
import * as ui from '../ui.js';

export interface SessionWizardAnswers {
  repoRoot: string;
  reqSources: string[];
  agent: string;
  userPreferences: string[];
  agentPreferences: string[];
  taskComponents: string[];
  worktreeBranch: string;
  runtimeProfile: string;
  runtimeMode: string;
  port: number;
  previewEnabled: boolean;
  previewTarget?: string;
  secrets: SecretSelection[];
}

// ── Step 1: REQ source ──────────────────────────────────────────────────────

async function discoverReqFiles(repoRoot: string): Promise<string[]> {
  return glob('.scheme/**/REQs/req-*.md', { cwd: repoRoot });
}

function domainOf(reqRelPath: string): string {
  const parts = reqRelPath.split('/');
  const idx = parts.indexOf('REQs');
  return idx >= 1 ? parts[idx - 1] : 'unknown';
}

async function stepReqSources(repoRoot: string): Promise<string[]> {
  const all = await discoverReqFiles(repoRoot);
  if (all.length === 0) {
    throw new Error(`No REQ files found under ${repoRoot}/.scheme/**/REQs/`);
  }

  const mode = await ui.select({
    message: 'Session source',
    options: [
      { value: 'single', label: 'One REQ file' },
      { value: 'set', label: 'Selected set of REQ files' },
      { value: 'domain', label: 'Full domain REQ set' },
    ],
    default: 'single',
  });

  if (mode === 'single') {
    const picked = await ui.select({
      message: 'Select REQ file',
      options: all.map((f) => ({ value: f, label: f })),
      default: all[0],
    });
    return [picked];
  }

  if (mode === 'set') {
    return ui.multiselect({
      message: 'Select REQ files',
      options: all.map((f) => ({ value: f, label: f })),
      required: true,
      default: [all[0]],
    });
  }

  const domains = Array.from(new Set(all.map(domainOf))).sort();
  const domain = await ui.select({
    message: 'Select domain',
    options: domains.map((d) => ({ value: d, label: d })),
    default: domains[0],
  });
  return all.filter((f) => domainOf(f) === domain);
}

// ── Step 2: Agent ────────────────────────────────────────────────────────────

function agentConfigured(agent: string): boolean {
  // Single-sourced from runtime/launch's `AGENT_REQUIRED_SECRETS` via `requiredSecretsFor()` — the
  // wizard does not keep its own agent→env-var map. An agent is "configured" when every required
  // secret is already present in process.env.
  const keys = requiredSecretsFor(agent);
  return keys.length > 0 && keys.every((key) => Boolean(process.env[key]));
}

async function stepAgent(wb: WorkbenchContext): Promise<string> {
  const providers = wb.config.agents.providers.filter((p) => p.enabled);
  const defaultAgent = providers.find((p) => agentConfigured(p.name))?.name ?? providers[0]?.name ?? 'claude';

  return ui.select({
    message: 'Select agent',
    options: providers.map((p) => ({
      value: p.name,
      label: p.name,
      hint: agentConfigured(p.name) ? 'configured' : 'not configured',
    })),
    default: defaultAgent,
  });
}

// ── Steps 3–5: markdown file pickers under `.this` ──────────────────────────

async function listMarkdownFiles(dir: string): Promise<string[]> {
  if (!fs.existsSync(dir)) return [];
  return glob('**/*.md', { cwd: dir });
}

async function stepUserPreferences(): Promise<string[]> {
  const dir = path.join(resolveMemoryThisDir(), 'user');
  const files = await listMarkdownFiles(dir);
  if (files.length === 0) return [];
  return ui.multiselect({
    message: 'Select user preferences to include',
    options: files.map((f) => ({ value: f, label: f })),
    required: false,
    default: [],
  });
}

async function stepAgentPreferences(agent: string): Promise<string[]> {
  const dir = path.join(resolveMemoryThisDir(), 'agents', agent);
  const files = await listMarkdownFiles(dir);
  if (files.length === 0) return [];
  return ui.multiselect({
    message: `Select ${agent} preferences to include`,
    options: files.map((f) => ({ value: f, label: f })),
    required: false,
    default: [],
  });
}

/**
 * Internal task components = prior tasks' journal records under
 * `.this/journals/<YYYY_MM_DD>/<task-id>/` (per `req-session-record-task-journal.md`). Multiselect
 * options are keyed by the record path relative to the journals root (`<date>/<task-id>`); the
 * selected records are resolved to their `journal.md` file, relative to the `.this` root, so the
 * returned paths are directly readable by `buildPromptBody()` in `sessions/store.ts` the same way
 * `reqSources` paths are.
 */
async function stepTaskComponents(): Promise<string[]> {
  const journalsDir = path.join(resolveMemoryThisDir(), 'journals');
  if (!fs.existsSync(journalsDir)) return [];

  const entries = await glob('*/*', { cwd: journalsDir });
  const records = entries.filter((rel) => fs.statSync(path.join(journalsDir, rel)).isDirectory());
  if (records.length === 0) return [];

  const selected = await ui.multiselect({
    message: 'Select prior task journal records to include as internal task components',
    options: records.map((rel) => ({ value: rel, label: rel })),
    required: false,
    default: [],
  });

  return selected.map((rel) => path.join('journals', rel, 'journal.md'));
}

// ── Step 6: worktree branch ──────────────────────────────────────────────────

function currentGitBranch(repoRoot: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch {
    return 'main';
  }
}

async function stepWorktreeBranch(repoRoot: string): Promise<string> {
  const current = currentGitBranch(repoRoot);
  const value = await ui.text({
    message: 'Worktree branch (enter to keep current branch)',
    placeholder: current,
    default: current,
  });
  return value.trim() || current;
}

// ── Step 7: runtime profile ──────────────────────────────────────────────────

interface RuntimeProfileEntry {
  mode: string;
  label?: string;
}

function readRuntimeProfiles(): { profiles: Record<string, RuntimeProfileEntry>; defaultRuntime: string } {
  const configPath = findConfigPath();
  const raw = configPath
    ? (parseYaml(fs.readFileSync(configPath, 'utf-8')) as { runtimes?: Record<string, RuntimeProfileEntry>; default_runtime?: string })
    : {};

  const profiles: Record<string, RuntimeProfileEntry> = {
    'bare-host': { mode: 'bare-host', label: 'Bare host (no sandbox)' },
    ...(raw.runtimes ?? {}),
  };
  return { profiles, defaultRuntime: raw.default_runtime ?? 'bare-host' };
}

async function stepRuntime(): Promise<{ profile: string; mode: string }> {
  const { profiles, defaultRuntime } = readRuntimeProfiles();
  const profile = await ui.select({
    message: 'Select runtime',
    options: Object.entries(profiles).map(([name, p]) => ({
      value: name,
      label: p.label ? `${name} (${p.label})` : name,
      hint: p.mode,
    })),
    default: defaultRuntime,
  });
  return { profile, mode: profiles[profile].mode };
}

// ── Step 8: port ─────────────────────────────────────────────────────────────

function suggestNextPort(range: [number, number]): number {
  const leasesFile = path.join(resolveWorkbenchDir(), 'leases.jsonl');
  const active = new Set<number>();
  if (fs.existsSync(leasesFile)) {
    for (const line of fs.readFileSync(leasesFile, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line) as { port: number; state: string };
        if (evt.state === 'released') active.delete(evt.port);
        else active.add(evt.port);
      } catch { /* skip malformed lines */ }
    }
  }
  for (let p = range[0]; p <= range[1]; p++) {
    if (!active.has(p)) return p;
  }
  throw new Error(`No free port in range ${range[0]}-${range[1]}`);
}

async function stepPort(wb: WorkbenchContext): Promise<number> {
  const suggested = suggestNextPort(wb.config.ports.range);
  const value = await ui.text({
    message: 'Port (enter to keep suggested)',
    placeholder: String(suggested),
    default: String(suggested),
    validate: (v) => (v.trim() && Number.isNaN(Number(v.trim())) ? 'Enter a port number' : undefined),
  });
  const trimmed = value.trim();
  return trimmed ? Number(trimmed) : suggested;
}

// ── Step 9: preview ──────────────────────────────────────────────────────────

async function stepPreview(wb: WorkbenchContext): Promise<{ enabled: boolean; target?: string }> {
  const enabled = await ui.confirm({ message: 'Use the preview workflow for this session?', default: false });
  if (!enabled) return { enabled: false };

  const targets = Array.from(new Set([wb.config.preview.default, ...wb.config.preview.rules.map((r) => r.provider)]));
  const target = await ui.select({
    message: 'Select preview target',
    options: targets.map((t) => ({ value: t, label: t })),
    default: wb.config.preview.default,
  });
  return { enabled: true, target };
}

// ── Step 10: conditional secrets ─────────────────────────────────────────────

async function stepSecrets(agent: string): Promise<SecretSelection[]> {
  const required = requiredSecretsFor(agent);
  const selections: SecretSelection[] = [];

  for (const key of required) {
    const existing = process.env[key];
    if (existing) {
      selections.push({ key, scope: 'global', source: 'configured' });
      continue;
    }
    const value = await ui.password({ message: `Value for ${key} (required by ${agent})` });
    process.env[key] = value;
    selections.push({ key, scope: 'global', source: 'prompted' });
  }

  return selections;
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function runSessionCreateWizard(
  wb: WorkbenchContext,
  repoRoot: string,
): Promise<SessionWizardAnswers> {
  ui.intro('Create a new session');

  const reqSources = await stepReqSources(repoRoot);
  const agent = await stepAgent(wb);
  const userPreferences = await stepUserPreferences();
  const agentPreferences = await stepAgentPreferences(agent);
  const taskComponents = await stepTaskComponents();
  const worktreeBranch = await stepWorktreeBranch(repoRoot);
  const { profile: runtimeProfile, mode: runtimeMode } = await stepRuntime();
  const port = await stepPort(wb);
  const { enabled: previewEnabled, target: previewTarget } = await stepPreview(wb);
  const secrets = await stepSecrets(agent);

  return {
    repoRoot,
    reqSources,
    agent,
    userPreferences,
    agentPreferences,
    taskComponents,
    worktreeBranch,
    runtimeProfile,
    runtimeMode,
    port,
    previewEnabled,
    previewTarget,
    secrets,
  };
}
