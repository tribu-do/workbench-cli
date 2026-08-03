/**
 * CLI: workbench init — Pillar-based initialization wizards (clack UX).
 *
 * Subcommands:
 *   init            — Workspace bootstrap wizard (group flow, default)
 *   init memory     — Configure memory context store (OpenViking)
 *   init sandboxing — Configure sandbox runtime
 *   init agent      — Configure AI agent credentials
 *   init deployment — Configure preview deployment provider
 */

import type { Command } from 'commander';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  DEFAULT_CONFIG,
  writeConfig,
  loadConfig,
  loadCredentials,
  findConfigPath,
  resolveDocsMcpDataDir,
  resolveJournalsDir,
  resolveSecretsDir,
  resolveMemoryThisDir,
  resolveRuntimesDir,
  resolveRuntimesLogsDir,
  CREDENTIALS_PATH,
  loadGlobalConfig,
  writeGlobalConfig,
  defaultEmbeddingModelFor,
  defaultApiBaseFor,
  resolveEmbeddingPreset,
} from '../../config.js';
import type { DocsEmbeddingPreset } from '../../config.js';
import {
  RUNTIME_MENU,
  isSupportedRuntimeMode,
  writeRuntimeProfile,
  appendRuntimeConfigEvent,
} from '../../runtime/registry.js';
import {
  probeDockerCompose,
  assertComposeFileExists,
  listComposeServices,
  assertServiceExists,
  generateSshKeypair,
  rollbackKeypair,
  buildInlineSettings,
  buildLocalSettings,
  buildAttachDescriptor,
  connectInstructions,
  ComposeFileNotFoundError,
  ComposeServiceNotFoundError,
  type DockerComposeAnswers,
  type SshKeypair,
} from '../../runtime/docker-compose.js';
import * as ui from '../ui.js';
import type { WorkbenchConfig, RuntimeMode, RuntimeModeId, DeploymentProviderName } from '../../types.js';

const DOCS_SERVER = '@arabold/docs-mcp-server@latest';

// ── Runtime profile named errors ─────────────────────────────────────────────────

class RuntimeProbeFailedError extends Error {
  constructor(public mode: RuntimeModeId, detail: string) {
    super(`Host prerequisite probe failed for runtime mode "${mode}": ${detail}`);
    this.name = 'RuntimeProbeFailedError';
  }
}

class RuntimeProfileExistsError extends Error {
  constructor(public profileName: string) {
    super(`Runtime profile "${profileName}" already exists. Pass --overwrite to replace it.`);
    this.name = 'RuntimeProfileExistsError';
  }
}

async function configureDockerCompose(
  profileName: string,
  config: WorkbenchConfig,
  overwrite: boolean,
): Promise<void> {
  // Prompt for the compose file path; reject a path that does not exist.
  const composeFile = await ui.text({
    message: 'Compose file path',
    placeholder: './docker-compose.yaml',
    validate: (v) => {
      try {
        assertComposeFileExists(v);
        return undefined;
      } catch (err) {
        return err instanceof ComposeFileNotFoundError ? err.message : 'Invalid path.';
      }
    },
  });

  // Read service names from the compose file; present as a select menu.
  const services = listComposeServices(composeFile);
  const service = await ui.select<string>({
    message: 'Select the service to run sessions in',
    options: services.map((s) => ({ value: s, label: s })),
  });

  // Abort with a named error if the selected service is absent from the resolved config.
  try {
    assertServiceExists(service, composeFile);
  } catch (err) {
    if (err instanceof ComposeServiceNotFoundError) {
      ui.log.error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  // Prompt for the absolute workspace folder path inside the container.
  const containerWorkspaceFolder = await ui.text({
    message: 'Absolute workspace folder path inside the container',
    placeholder: '/workspace',
    validate: (v) => (v.startsWith('/') ? undefined : 'Must be an absolute path (start with "/").'),
  });

  const sshUsername = await ui.text({
    message: 'SSH username for the container',
    initialValue: 'root',
    default: 'root',
  });

  const answers: DockerComposeAnswers = { composeFile, service, containerWorkspaceFolder, sshUsername };

  // Generate a dedicated SSH keypair, owner-only permissions, under .workbench/runtimes/docker-compose/.
  let keypair: SshKeypair | undefined;
  try {
    keypair = await ui.spin('Generating SSH keypair', async () => generateSshKeypair(profileName));

    const updated = writeRuntimeProfile(config, {
      profileName,
      mode: 'docker-compose',
      label: `Docker Compose (${service})`,
      inlineSettings: buildInlineSettings(answers),
      localSettings: buildLocalSettings(answers, keypair),
    });
    writeConfig(updated);

    appendRuntimeConfigEvent({
      profileName,
      mode: 'docker-compose',
      probeResult: 'passed',
      overwrite,
      outcome: 'configured',
      detail: { composeFile, service },
    });

    const descriptor = buildAttachDescriptor(answers, keypair);
    ui.note(connectInstructions(profileName, descriptor), 'Connect VSCode');
    ui.outro(`Runtime profile "${profileName}" configured (docker-compose: ${service}).`);
  } catch (err) {
    // Remove the generated keypair + local settings file if configuration fails
    // after the keypair was written.
    if (keypair) rollbackKeypair(profileName, keypair);

    appendRuntimeConfigEvent({
      profileName,
      mode: 'docker-compose',
      probeResult: 'passed',
      overwrite,
      outcome: 'failed',
      detail: { composeFile, service, error: err instanceof Error ? err.message : String(err) },
    });

    ui.log.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}

// Runtime modes / providers accepted from prompt input (raw string → narrowed union).
const RUNTIME_MODES: readonly RuntimeMode[] = ['daemon-managed', 'dev-managed', 'bare-host'];
const PROVIDER_NAMES: readonly DeploymentProviderName[] = ['coolify', 'netlify', 'cloudflare'];

function asRuntimeMode(raw: string): RuntimeMode {
  return (RUNTIME_MODES as readonly string[]).includes(raw) ? (raw as RuntimeMode) : DEFAULT_CONFIG.runtime.mode;
}

function asProviderName(raw: string): DeploymentProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(raw) ? (raw as DeploymentProviderName) : DEFAULT_CONFIG.preview.default;
}

// ── Credential helpers ─────────────────────────────────────────────────────────

function ensureCredentialsFile(): void {
  // Ensure the ~/.workbench/ global settings directory exists, then the file.
  fs.mkdirSync(path.dirname(CREDENTIALS_PATH), { recursive: true });
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    fs.writeFileSync(CREDENTIALS_PATH, '# Workbench credentials\n# chmod 600 this file\n', { mode: 0o600 });
  }
}

function appendCredential(key: string, value: string): void {
  ensureCredentialsFile();
  const content = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
  const lines = content.split('\n').filter((l) => !l.startsWith(`export ${key}=`));
  lines.push(`export ${key}="${value}"`);
  fs.writeFileSync(CREDENTIALS_PATH, lines.join('\n') + '\n', { mode: 0o600 });
}

function getCredential(key: string): string | undefined {
  loadCredentials();
  return process.env[key];
}

// ── Domain configuration detection ─────────────────────────────────────────────

interface ConfiguredDomains {
  memory: boolean;
  sandboxing: boolean;
  agent: boolean;
  deployment: boolean;
}

function configuredDomains(): ConfiguredDomains {
  loadCredentials();
  const env = process.env;
  return {
    memory: Boolean(env.WORKBENCH_MEMORY_BACKEND),
    sandboxing: Boolean(env.WORKBENCH_SANDBOX_BACKEND),
    agent: Boolean(env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY || env.GITHUB_TOKEN || env.WORKBENCH_OLLAMA_URL),
    deployment: Boolean(env.WORKBENCH_COOLIFY_TOKEN || env.WORKBENCH_NETLIFY_TOKEN || env.WORKBENCH_CLOUDFLARE_API_TOKEN),
  };
}

function domainOptions(configured: ConfiguredDomains): ui.SelectOption<string>[] {
  return [
    { value: 'memory', label: 'memory', hint: 'context store', disabled: configured.memory },
    { value: 'sandboxing', label: 'sandboxing', hint: 'runtime', disabled: configured.sandboxing },
    { value: 'agent', label: 'agent', hint: 'AI credentials', disabled: configured.agent },
    { value: 'deployment', label: 'deployment', hint: 'preview provider', disabled: configured.deployment },
  ];
}

// ── Workspace scaffold ─────────────────────────────────────────────────────────

function scaffoldWorkspace(opts: { name: string; mode: RuntimeMode; provider: DeploymentProviderName }): void {
  // Local state tree (file-first — no SQLite database is created).
  fs.mkdirSync(resolveMemoryThisDir(), { recursive: true });
  fs.mkdirSync(resolveJournalsDir(), { recursive: true });
  fs.mkdirSync(resolveDocsMcpDataDir(), { recursive: true });
  fs.mkdirSync(resolveSecretsDir(), { recursive: true });
  fs.mkdirSync(resolveRuntimesDir(), { recursive: true });
  fs.mkdirSync(resolveRuntimesLogsDir(), { recursive: true });

  // Installation manifest — workbench.yaml at project root.
  const config: WorkbenchConfig = {
    ...DEFAULT_CONFIG,
    workspace: { id: crypto.randomUUID().slice(0, 8), name: opts.name },
    runtime: { ...DEFAULT_CONFIG.runtime, mode: opts.mode },
    preview: { ...DEFAULT_CONFIG.preview, default: opts.provider },
  };
  writeConfig(config);

  // Global settings directory — ~/.workbench/ with credentials file.
  ensureCredentialsFile();

  // Warm the docs-mcp-server package into the npx cache (non-destructive install).
  try {
    execFileSync('npx', ['--yes', DOCS_SERVER, '--version'], {
      stdio: 'ignore',
      timeout: 120_000,
    });
  } catch {
    // Non-fatal: docs command re-checks availability at call time.
  }
}

function addToGitignore(): boolean {
  const gitignorePath = path.join(process.cwd(), '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    if (content.includes('.workbench')) return false;
    fs.appendFileSync(gitignorePath, '\n# Workbench local data\n.workbench/\n');
    return true;
  }
  fs.writeFileSync(gitignorePath, '# Workbench local data\n.workbench/\n');
  return true;
}

// ── Command registration ───────────────────────────────────────────────────────

export function registerInitCommand(program: Command): void {
  const init = program
    .command('init')
    .description('Initialize Workbench workspace and tooling');

  // ── init workspace (default) ─────────────────────────────────────────────────
  init
    .command('workspace', { isDefault: true })
    .description('Initialize a Workbench workspace in the current directory')
    .option('-n, --name <name>', 'Workspace name', path.basename(process.cwd()))
    .option('--mode <mode>', 'Runtime mode', 'daemon-managed')
    .option('--provider <provider>', 'Default preview provider', 'coolify')
    .action(async (opts) => {
      ui.intro('Workspace initialization');

      if (findConfigPath(process.cwd())) {
        ui.log.warn('Workbench is already initialized in this directory.');
        return;
      }

      const wizard = await ui.group<{
        scaffold: void;
        domains: string[];
        gitignore: boolean;
      }>({
        scaffold: () =>
          ui.spin('Creating workspace state tree and docs cache', async () => {
            // Commander options arrive as `string`; narrow to the config unions before assignment.
            scaffoldWorkspace({
              name: opts.name,
              mode: asRuntimeMode(opts.mode),
              provider: asProviderName(opts.provider),
            });
          }),
        domains: () =>
          ui.multiselect<string>({
            message: 'Continue with:',
            options: domainOptions(configuredDomains()),
            required: false,
            default: [],
          }),
        gitignore: () =>
          ui.confirm({
            message: 'Add .workbench to .gitignore?',
            initialValue: true,
            default: false,
          }),
      });

      if (wizard.gitignore) {
        const added = addToGitignore();
        if (added) ui.log.success('Added .workbench/ to .gitignore');
      }

      const nextSteps = (wizard.domains.length > 0)
        ? wizard.domains.map((d) => `workbench init ${d}`).join('\n')
        : 'workbench init memory\nworkbench init agent';

      ui.outro(`Workspace "${opts.name}" initialized.`, nextSteps);
    });

  // ── init memory ──────────────────────────────────────────────────────────────
  init
    .command('memory')
    .description('Configure memory context store (OpenViking)')
    .action(async () => {
      ui.intro('Memory setup');
      const configured = configuredDomains().memory;

      // Only OpenViking is offered today; if it is already configured every option
      // would be disabled and an interactive select would loop forever. Short-circuit.
      if (configured) {
        ui.note('Memory backend is already configured (openviking). Edit ~/.workbench/credentials to reconfigure.', 'Already configured');
        ui.outro('Nothing to do.');
        return;
      }

      const store = await ui.select<string>({
        message: 'Select memory context store to configure',
        options: [
          { value: 'openviking', label: 'OpenViking', hint: 'contextual memory', disabled: configured },
        ],
        default: 'openviking',
      });

      if (store === 'openviking') {
        const mode = await ui.select<string>({
          message: 'OpenViking mode',
          options: [
            { value: 'embedded', label: 'Embedded Mode', hint: 'local python library' },
            { value: 'client-docker', label: 'Client-DockerServer Mode', hint: 'docker service' },
          ],
          default: 'client-docker',
        });

        if (mode === 'client-docker') {
          const url = await ui.text({
            message: 'OpenViking service URL',
            initialValue: getCredential('WORKBENCH_OPENVIKING_URL') ?? 'http://localhost:8000',
            default: getCredential('WORKBENCH_OPENVIKING_URL') ?? 'http://localhost:8000',
          });
          appendCredential('WORKBENCH_OPENVIKING_URL', url);
          appendCredential('WORKBENCH_OPENVIKING_MODE', 'client-docker');
          ui.note('docker run -d --name workbench-openviking -p 8000:8000 openviking/openviking:latest', 'Start the service');
        } else {
          appendCredential('WORKBENCH_OPENVIKING_MODE', 'embedded');
          ui.note('pip install openviking', 'Install locally');
        }

        appendCredential('WORKBENCH_MEMORY_BACKEND', 'openviking');
        ui.outro('Memory backend configured: openviking');
      }
    });

  // ── init sandboxing ──────────────────────────────────────────────────────────
  init
    .command('sandboxing')
    .description('Configure a runtime profile for launching sessions')
    .option('--overwrite', 'Replace the profile if the name already exists', false)
    .action(async (opts) => {
      ui.intro('Runtime profile setup');

      const config = loadConfig();

      // 1. Render every menu entry — including menu-only planned modes such as
      //    `nvidia-shell` that are NOT supported RuntimeModeIds. Unavailable
      //    entries get a distinct "(unavailable — …)" decoration rather than the
      //    green-✓ disabled style (which reads as "configured"), and selecting
      //    one re-prompts instead of proceeding.
      let modeId: RuntimeModeId;
      while (true) {
        const picked = await ui.select<string>({
          message: 'Select runtime mode to configure',
          options: RUNTIME_MENU.map((m) => ({
            value: m.id,
            label: m.available ? m.label : `${m.label} (unavailable — ${m.unavailableReason})`,
            hint: m.available ? undefined : m.unavailableReason,
          })),
          default: 'bare-host',
        });
        const entry = RUNTIME_MENU.find((m) => m.id === picked);
        if (!entry?.available || !isSupportedRuntimeMode(picked)) {
          ui.log.warn(
            `"${entry?.label ?? picked}" is not available to configure (${entry?.unavailableReason ?? 'unsupported runtime mode'}).`,
          );
          continue;
        }
        modeId = picked; // narrowed to RuntimeModeId by isSupportedRuntimeMode
        break;
      }

      // 2. Prompt for a profile name after the mode is selected (a mode may hold >1 profile).
      const profileName = await ui.text({
        message: 'Profile name',
        placeholder: modeId,
        initialValue: modeId,
        default: modeId,
        validate: (v) => (v.trim().length === 0 ? 'Profile name is required.' : undefined),
      });

      const exists = Boolean(config.runtimes[profileName]);
      if (exists && !opts.overwrite) {
        ui.log.error(new RuntimeProfileExistsError(profileName).message);
        process.exitCode = 1;
        return;
      }

      // 3. Run the mode's host prerequisite probe before collecting settings.
      const probe = modeId === 'docker-compose'
        ? probeDockerCompose()
        : { ok: true, detail: `${modeId} has no external host prerequisite.` };

      if (!probe.ok) {
        // Probe failure writes NOTHING: no profile config and no log event, so
        // .workbench/runtimes/ (including its logs dir) is left untouched.
        ui.log.error(new RuntimeProbeFailedError(modeId, probe.detail).message);
        process.exitCode = 1;
        return;
      }

      try {
        if (modeId === 'bare-host') {
          const updated = writeRuntimeProfile(config, {
            profileName,
            mode: 'bare-host',
            label: 'Bare Host',
            inlineSettings: {},
          });
          writeConfig(updated);
          appendRuntimeConfigEvent({
            profileName, mode: 'bare-host', probeResult: 'passed',
            overwrite: Boolean(opts.overwrite), outcome: 'configured',
          });
          ui.outro(`Runtime profile "${profileName}" configured (bare-host).`);
          return;
        }

        if (modeId === 'docker-compose') {
          await configureDockerCompose(profileName, config, Boolean(opts.overwrite));
          return;
        }

        // devcontainer / aio-sandbox: unreachable while `available: false` keeps them disabled.
        ui.log.error(`Runtime mode "${modeId}" has no drafted configuration flow yet.`);
        process.exitCode = 1;
      } catch (err) {
        appendRuntimeConfigEvent({
          profileName, mode: modeId, probeResult: 'passed',
          overwrite: Boolean(opts.overwrite), outcome: 'failed',
          detail: { error: err instanceof Error ? err.message : String(err) },
        });
        ui.log.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
      }
    });

  // ── init agent ───────────────────────────────────────────────────────────────
  init
    .command('agent')
    .description('Configure AI agent credentials')
    .action(async () => {
      ui.intro('Agent setup');
      loadCredentials();
      const env = process.env;

      const agent = await ui.select<string>({
        message: 'Select agent to configure',
        options: [
          { value: 'claude', label: 'claude', hint: 'Anthropic', disabled: Boolean(env.ANTHROPIC_API_KEY) },
          { value: 'codex', label: 'codex', hint: 'OpenAI', disabled: Boolean(env.OPENAI_API_KEY) },
          { value: 'copilot', label: 'copilot', hint: 'GitHub', disabled: Boolean(env.GITHUB_TOKEN) },
          { value: 'opencode', label: 'opencode', hint: 'local Ollama', disabled: Boolean(env.WORKBENCH_OLLAMA_URL) },
        ],
        default: 'claude',
      });

      const keyByAgent: Record<string, { key: string; url: string }> = {
        claude: { key: 'ANTHROPIC_API_KEY', url: 'https://console.anthropic.com/settings/keys' },
        codex: { key: 'OPENAI_API_KEY', url: 'https://platform.openai.com/api-keys' },
        copilot: { key: 'GITHUB_TOKEN', url: 'https://github.com/settings/tokens' },
      };

      if (agent === 'opencode') {
        const url = await ui.text({
          message: 'Ollama URL',
          initialValue: 'http://localhost:11434',
          default: 'http://localhost:11434',
        });
        appendCredential('WORKBENCH_OLLAMA_URL', url);
        ui.outro('Agent configured: opencode');
        return;
      }

      const spec = keyByAgent[agent];
      ui.note(`Get your key from: ${spec.url}`, agent);
      const value = await ui.password({ message: spec.key });
      if (value) appendCredential(spec.key, value);
      ui.outro(`Agent configured: ${agent}`);
    });

  // ── init deployment ──────────────────────────────────────────────────────────
  init
    .command('deployment')
    .description('Configure preview deployment provider')
    .action(async () => {
      ui.intro('Deployment setup');
      loadCredentials();
      const env = process.env;

      const provider = await ui.select<string>({
        message: 'Select provider to deploy to',
        options: [
          { value: 'coolify', label: 'coolify', disabled: Boolean(env.WORKBENCH_COOLIFY_TOKEN) },
          { value: 'netlify', label: 'netlify', disabled: Boolean(env.WORKBENCH_NETLIFY_TOKEN) },
          { value: 'cloudflare', label: 'cloudflare', disabled: Boolean(env.WORKBENCH_CLOUDFLARE_API_TOKEN) },
        ],
        default: 'coolify',
      });

      if (provider === 'coolify') {
        const url = await ui.text({
          message: 'Coolify URL',
          initialValue: getCredential('WORKBENCH_COOLIFY_URL') ?? 'https://coolify.example.com',
          default: getCredential('WORKBENCH_COOLIFY_URL') ?? 'https://coolify.example.com',
        });
        appendCredential('WORKBENCH_COOLIFY_URL', url);
        const token = await ui.password({ message: 'WORKBENCH_COOLIFY_TOKEN' });
        if (token) appendCredential('WORKBENCH_COOLIFY_TOKEN', token);
      } else if (provider === 'netlify') {
        const token = await ui.password({ message: 'WORKBENCH_NETLIFY_TOKEN' });
        if (token) appendCredential('WORKBENCH_NETLIFY_TOKEN', token);
      } else if (provider === 'cloudflare') {
        const token = await ui.password({ message: 'WORKBENCH_CLOUDFLARE_API_TOKEN' });
        if (token) appendCredential('WORKBENCH_CLOUDFLARE_API_TOKEN', token);
      }

      ui.outro(`Deployment provider configured: ${provider}`);
    });

  // ── init docs ────────────────────────────────────────────────────────────────
  init
    .command('docs')
    .description('Configure the embedding model used by the docs server (optional)')
    .action(async () => {
      ui.intro('Docs embedding model setup');

      const preset = await ui.select<DocsEmbeddingPreset>({
        message: 'Select embedding model preset',
        options: [
          { value: 'openai', label: 'openai', hint: 'OpenAI embeddings API' },
          { value: 'ollama', label: 'ollama', hint: 'local, OpenAI-compatible' },
          { value: 'lm-studio', label: 'lm-studio', hint: 'local, OpenAI-compatible' },
        ],
        default: 'openai',
      });

      const modelDefault = defaultEmbeddingModelFor(preset);
      const modelName = await ui.text({
        message: 'Embedding model name',
        initialValue: modelDefault,
        default: modelDefault,
        validate: (v) => (v.trim() ? undefined : 'Model name is required'),
      });

      let apiBase: string | undefined;
      if (preset !== 'openai') {
        const baseDefault = defaultApiBaseFor(preset);
        apiBase = await ui.text({
          message: `${preset} base URL`,
          initialValue: baseDefault,
          default: baseDefault,
        });
      }

      const resolved = resolveEmbeddingPreset(preset, modelName);
      if (apiBase) resolved.apiBase = apiBase;

      if (preset === 'openai') {
        const apiKey = await ui.password({ message: 'OPENAI_API_KEY' });
        if (apiKey) appendCredential('OPENAI_API_KEY', apiKey);
      }

      writeGlobalConfig({
        ...loadGlobalConfig(),
        docs: { preset, embeddingModel: resolved.embeddingModel, apiBase: resolved.apiBase },
      });

      ui.outro(
        `Docs embedding model configured: ${resolved.embeddingModel}` +
        (resolved.apiBase ? ` @ ${resolved.apiBase}` : ''),
      );
    });
}
