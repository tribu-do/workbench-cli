/**
 * Runtime backend abstraction — Pluggable sandbox environments.
 *
 * Backends:
 *   - aio-sandbox: AIO all-in-one sandbox (Browser, Shell, File, MCP, VSCode Server)
 *   - openshell: NVIDIA OpenShell policy-governed execution
 *   - devcontainer: VS Code devcontainer spec
 *   - docker: Basic Docker container (current default)
 *
 * Each backend implements the RuntimeBackend interface for:
 *   - Container/environment provisioning
 *   - Agent CLI installation
 *   - Attach/detach session management
 *   - Health checks
 */

import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import type { PortLease } from '../types.js';

const execFileAsync = promisify(execFile);

export type SandboxBackend = 'aio-sandbox' | 'openshell' | 'devcontainer' | 'docker';

export interface RuntimeSpec {
  taskId: string;
  sessionId: string;
  worktreePath: string;
  agent: 'claude' | 'codex' | 'copilot';
  envVars?: Record<string, string>;
  ports?: PortLease[];
  /** Custom image override */
  image?: string;
}

export interface RuntimeHandle {
  backend: SandboxBackend;
  containerId?: string;
  processId?: number;
  name: string;
  startedAt: string;
  agentProvisioned: boolean;
  vsCodeUrl?: string;
}

export interface AttachOptions {
  prompt?: string;
  autoApprove: boolean;
  interactive: boolean;
}

export interface RuntimeBackend {
  readonly name: SandboxBackend;

  /** Check if this backend is available on the system */
  isAvailable(): boolean;

  /** Provision a new runtime environment for a task */
  provision(spec: RuntimeSpec): Promise<RuntimeHandle>;

  /** Attach to a running runtime (launches agent CLI) */
  attach(handle: RuntimeHandle, opts: AttachOptions): Promise<ChildProcess | null>;

  /** Detach from runtime without stopping it */
  detach(handle: RuntimeHandle): Promise<void>;

  /** Stop and clean up the runtime */
  destroy(handle: RuntimeHandle): Promise<void>;

  /** Check if runtime is still running */
  isRunning(handle: RuntimeHandle): Promise<boolean>;

  /** Execute a command in the runtime */
  exec(handle: RuntimeHandle, command: string[], env?: Record<string, string>): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}

// Agent CLI packages for npm install
const AGENT_NPM_PACKAGES: Record<string, string> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  copilot: '@github/copilot-cli',
};

/**
 * Basic Docker backend (current implementation)
 */
export class DockerBackend implements RuntimeBackend {
  readonly name: SandboxBackend = 'docker';

  isAvailable(): boolean {
    try {
      execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
      });
      return true;
    } catch {
      return false;
    }
  }

  async provision(spec: RuntimeSpec): Promise<RuntimeHandle> {
    const image = spec.image ?? process.env.WORKBENCH_RUNTIME_IMAGE ?? 'node:22-bookworm-slim';
    const name = `wb-${spec.taskId.slice(0, 12)}`;

    const args = [
      'run', '-d',
      '--name', name,
      '-v', `${spec.worktreePath}:/workspace`,
      '-w', '/workspace',
      '--label', `workbench.task=${spec.taskId}`,
      '--label', `workbench.session=${spec.sessionId}`,
      '--label', `workbench.backend=docker`,
    ];

    for (const [k, v] of Object.entries(spec.envVars ?? {})) {
      args.push('-e', `${k}=${v}`);
    }

    for (const lease of spec.ports ?? []) {
      args.push('-p', `${lease.port}:${lease.port}/${lease.protocol}`);
    }

    args.push(image, 'sh', '-c', 'tail -f /dev/null');

    const { stdout } = await execFileAsync('docker', args);
    const containerId = stdout.trim();

    // Provision agent CLI
    const agentProvisioned = await this.provisionAgent(containerId, spec.agent);

    return {
      backend: 'docker',
      containerId,
      name,
      startedAt: new Date().toISOString(),
      agentProvisioned,
    };
  }

  private async provisionAgent(containerId: string, agent: string): Promise<boolean> {
    const pkg = AGENT_NPM_PACKAGES[agent];
    if (!pkg) return false;

    const result = await this.exec({ containerId } as RuntimeHandle, ['npm', 'install', '-g', pkg]);
    if (result.exitCode !== 0) return false;

    const verify = await this.exec({ containerId } as RuntimeHandle, [agent, '--version']);
    return verify.exitCode === 0;
  }

  async attach(handle: RuntimeHandle, opts: AttachOptions): Promise<ChildProcess | null> {
    if (!handle.containerId) return null;

    const agentArgs: string[] = [];
    if (opts.autoApprove) {
      agentArgs.push('--dangerously-skip-permissions');
    }
    if (opts.prompt) {
      agentArgs.push(opts.prompt);
    }

    const dockerArgs = ['exec', '-it', handle.containerId, 'claude', ...agentArgs];

    if (opts.interactive) {
      const child = spawn('docker', dockerArgs, {
        stdio: 'inherit',
        detached: false,
      });
      return child;
    }

    // Detached mode for background execution
    const child = spawn('docker', ['exec', '-d', handle.containerId, 'claude', ...agentArgs], {
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    return child;
  }

  async detach(_handle: RuntimeHandle): Promise<void> {
    // Docker containers continue running; detach is a no-op
  }

  async destroy(handle: RuntimeHandle): Promise<void> {
    if (!handle.containerId) return;
    try {
      await execFileAsync('docker', ['rm', '-f', handle.containerId]);
    } catch {
      // Container already gone
    }
  }

  async isRunning(handle: RuntimeHandle): Promise<boolean> {
    if (!handle.containerId) return false;
    try {
      const { stdout } = await execFileAsync('docker', [
        'inspect', '-f', '{{.State.Running}}', handle.containerId,
      ]);
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  async exec(handle: RuntimeHandle, command: string[], env?: Record<string, string>): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }> {
    if (!handle.containerId) {
      return { exitCode: 1, stdout: '', stderr: 'No container ID' };
    }

    const args = ['exec'];
    for (const [k, v] of Object.entries(env ?? {})) {
      args.push('-e', `${k}=${v}`);
    }
    args.push(handle.containerId, ...command);

    try {
      const { stdout, stderr } = await execFileAsync('docker', args);
      return { exitCode: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return {
        exitCode: e.code ?? 1,
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? (err instanceof Error ? err.message : String(err)),
      };
    }
  }
}

/**
 * AIO Sandbox backend — All-in-one agent sandbox with VSCode Server
 */
export class AIOSandboxBackend implements RuntimeBackend {
  readonly name: SandboxBackend = 'aio-sandbox';

  isAvailable(): boolean {
    // Check if AIO image is available or can be pulled
    try {
      const image = process.env.WORKBENCH_AIO_IMAGE ?? 'agent-infra/aio-sandbox:latest';
      execFileSync('docker', ['image', 'inspect', image], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      });
      return true;
    } catch {
      // Try to check if docker is available at all
      try {
        execFileSync('docker', ['version'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
        return true; // Docker available, image can be pulled
      } catch {
        return false;
      }
    }
  }

  async provision(spec: RuntimeSpec): Promise<RuntimeHandle> {
    const image = spec.image ?? process.env.WORKBENCH_AIO_IMAGE ?? 'agent-infra/aio-sandbox:latest';
    const name = `wb-aio-${spec.taskId.slice(0, 12)}`;
    const vsCodePort = process.env.WORKBENCH_AIO_VSCODE_PORT ?? '8080';

    const args = [
      'run', '-d',
      '--name', name,
      '-v', `${spec.worktreePath}:/workspace`,
      '-w', '/workspace',
      '-p', `${vsCodePort}:8080`, // VSCode Server
      '--label', `workbench.task=${spec.taskId}`,
      '--label', `workbench.session=${spec.sessionId}`,
      '--label', `workbench.backend=aio-sandbox`,
    ];

    for (const [k, v] of Object.entries(spec.envVars ?? {})) {
      args.push('-e', `${k}=${v}`);
    }

    for (const lease of spec.ports ?? []) {
      args.push('-p', `${lease.port}:${lease.port}/${lease.protocol}`);
    }

    args.push(image);

    const { stdout } = await execFileAsync('docker', args);
    const containerId = stdout.trim();

    // AIO Sandbox should have agent CLIs pre-installed, but verify
    const agentProvisioned = await this.verifyAgent(containerId, spec.agent);

    return {
      backend: 'aio-sandbox',
      containerId,
      name,
      startedAt: new Date().toISOString(),
      agentProvisioned,
      vsCodeUrl: `http://localhost:${vsCodePort}`,
    };
  }

  private async verifyAgent(containerId: string, agent: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('docker', ['exec', containerId, agent, '--version']);
      return stdout.length > 0;
    } catch {
      // Try to install if not present
      const pkg = AGENT_NPM_PACKAGES[agent];
      if (!pkg) return false;

      try {
        await execFileAsync('docker', ['exec', containerId, 'npm', 'install', '-g', pkg]);
        await execFileAsync('docker', ['exec', containerId, agent, '--version']);
        return true;
      } catch {
        return false;
      }
    }
  }

  async attach(handle: RuntimeHandle, opts: AttachOptions): Promise<ChildProcess | null> {
    // Same as Docker backend for now
    if (!handle.containerId) return null;

    const agentArgs: string[] = [];
    if (opts.autoApprove) {
      agentArgs.push('--dangerously-skip-permissions');
    }
    if (opts.prompt) {
      agentArgs.push(opts.prompt);
    }

    const dockerArgs = ['exec', '-it', handle.containerId, 'claude', ...agentArgs];

    if (opts.interactive) {
      return spawn('docker', dockerArgs, { stdio: 'inherit', detached: false });
    }

    const child = spawn('docker', ['exec', '-d', handle.containerId, 'claude', ...agentArgs], {
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    return child;
  }

  async detach(_handle: RuntimeHandle): Promise<void> {
    // AIO containers continue running
  }

  async destroy(handle: RuntimeHandle): Promise<void> {
    if (!handle.containerId) return;
    try {
      await execFileAsync('docker', ['rm', '-f', handle.containerId]);
    } catch {
      // Already gone
    }
  }

  async isRunning(handle: RuntimeHandle): Promise<boolean> {
    if (!handle.containerId) return false;
    try {
      const { stdout } = await execFileAsync('docker', [
        'inspect', '-f', '{{.State.Running}}', handle.containerId,
      ]);
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  async exec(handle: RuntimeHandle, command: string[], env?: Record<string, string>): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }> {
    if (!handle.containerId) {
      return { exitCode: 1, stdout: '', stderr: 'No container ID' };
    }

    const args = ['exec'];
    for (const [k, v] of Object.entries(env ?? {})) {
      args.push('-e', `${k}=${v}`);
    }
    args.push(handle.containerId, ...command);

    try {
      const { stdout, stderr } = await execFileAsync('docker', args);
      return { exitCode: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return {
        exitCode: e.code ?? 1,
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? (err instanceof Error ? err.message : String(err)),
      };
    }
  }
}

/**
 * Devcontainer backend — Uses VS Code devcontainer CLI
 */
export class DevcontainerBackend implements RuntimeBackend {
  readonly name: SandboxBackend = 'devcontainer';

  isAvailable(): boolean {
    try {
      execFileSync('devcontainer', ['--version'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
      });
      return true;
    } catch {
      return false;
    }
  }

  async provision(spec: RuntimeSpec): Promise<RuntimeHandle> {
    const configDir = process.env.WORKBENCH_DEVCONTAINER_DIR ?? '.devcontainer';
    const configPath = path.join(spec.worktreePath, configDir, 'devcontainer.json');

    if (!fs.existsSync(configPath)) {
      throw new Error(`Devcontainer config not found at ${configPath}`);
    }

    const name = `wb-devcontainer-${spec.taskId.slice(0, 12)}`;

    // Build and start the devcontainer
    await execFileAsync('devcontainer', [
      'up',
      '--workspace-folder', spec.worktreePath,
      '--container-name', name,
    ]);

    // Get container ID
    const { stdout } = await execFileAsync('docker', [
      'ps', '-qf', `name=${name}`,
    ]);
    const containerId = stdout.trim();

    // Provision agent
    const agentProvisioned = await this.provisionAgent(containerId, spec.agent);

    return {
      backend: 'devcontainer',
      containerId,
      name,
      startedAt: new Date().toISOString(),
      agentProvisioned,
    };
  }

  private async provisionAgent(containerId: string, agent: string): Promise<boolean> {
    const pkg = AGENT_NPM_PACKAGES[agent];
    if (!pkg) return false;

    try {
      await execFileAsync('docker', ['exec', containerId, 'npm', 'install', '-g', pkg]);
      await execFileAsync('docker', ['exec', containerId, agent, '--version']);
      return true;
    } catch {
      return false;
    }
  }

  async attach(handle: RuntimeHandle, opts: AttachOptions): Promise<ChildProcess | null> {
    if (!handle.containerId) return null;

    const agentArgs: string[] = [];
    if (opts.autoApprove) {
      agentArgs.push('--dangerously-skip-permissions');
    }
    if (opts.prompt) {
      agentArgs.push(opts.prompt);
    }

    if (opts.interactive) {
      return spawn('docker', ['exec', '-it', handle.containerId, 'claude', ...agentArgs], {
        stdio: 'inherit',
        detached: false,
      });
    }

    const child = spawn('docker', ['exec', '-d', handle.containerId, 'claude', ...agentArgs], {
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    return child;
  }

  async detach(_handle: RuntimeHandle): Promise<void> {
    // Devcontainer continues running
  }

  async destroy(handle: RuntimeHandle): Promise<void> {
    if (!handle.containerId) return;
    try {
      await execFileAsync('docker', ['rm', '-f', handle.containerId]);
    } catch {
      // Already gone
    }
  }

  async isRunning(handle: RuntimeHandle): Promise<boolean> {
    if (!handle.containerId) return false;
    try {
      const { stdout } = await execFileAsync('docker', [
        'inspect', '-f', '{{.State.Running}}', handle.containerId,
      ]);
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  async exec(handle: RuntimeHandle, command: string[], env?: Record<string, string>): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }> {
    if (!handle.containerId) {
      return { exitCode: 1, stdout: '', stderr: 'No container ID' };
    }

    const args = ['exec'];
    for (const [k, v] of Object.entries(env ?? {})) {
      args.push('-e', `${k}=${v}`);
    }
    args.push(handle.containerId, ...command);

    try {
      const { stdout, stderr } = await execFileAsync('docker', args);
      return { exitCode: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return {
        exitCode: e.code ?? 1,
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? (err instanceof Error ? err.message : String(err)),
      };
    }
  }
}

/**
 * Get the configured runtime backend
 */
export function getBackend(name?: SandboxBackend): RuntimeBackend {
  const backendName = name ?? (process.env.WORKBENCH_SANDBOX_BACKEND as SandboxBackend) ?? 'docker';

  switch (backendName) {
    case 'aio-sandbox':
      return new AIOSandboxBackend();
    case 'devcontainer':
      return new DevcontainerBackend();
    case 'docker':
    default:
      return new DockerBackend();
  }
}

/**
 * List all available backends on this system
 */
export function listAvailableBackends(): Array<{ name: SandboxBackend; available: boolean }> {
  const backends: RuntimeBackend[] = [
    new DockerBackend(),
    new AIOSandboxBackend(),
    new DevcontainerBackend(),
  ];

  return backends.map((b) => ({
    name: b.name,
    available: b.isAvailable(),
  }));
}
