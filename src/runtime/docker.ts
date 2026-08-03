/**
 * Docker runtime adapter — Provisions containers per task in daemon-managed mode.
 *
 * Image strategy:
 *   - Default: `node:22-bookworm-slim` (matches package.json engines.node)
 *   - Override: WORKBENCH_RUNTIME_IMAGE env or runtime.image in workbench.yaml
 *
 * Container lifecycle:
 *   create → start → provision agent → exec → stop → rm
 *
 * Mounts:
 *   - worktree → /workspace (rw)
 *   - secrets tmpfs → /run/workbench/secrets (in dev-managed)
 *
 * Agent provisioning:
 *   If the host doesn't have the agent CLI bind-mountable, we install it
 *   inside the container via npm. Requires ANTHROPIC_API_KEY (for Claude)
 *   or equivalent credentials passed in envVars.
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import type { PortLease } from '../types.js';

const execFileAsync = promisify(execFile);

/** Agent CLI packages for npm install */
const AGENT_NPM_PACKAGES: Record<string, string> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  copilot: '@github/copilot-cli',
};

export interface ContainerSpec {
  taskId: string;
  worktreePath: string;
  image?: string;
  envVars?: Record<string, string>;
  ports?: PortLease[];
  /** Agent to provision (claude, codex, copilot). If set, installs the CLI. */
  agent?: 'claude' | 'codex' | 'copilot';
}

export interface ContainerHandle {
  id: string;
  name: string;
  image: string;
  startedAt: string;
  /** True if agent CLI was successfully provisioned in the container. */
  agentProvisioned: boolean;
}

export class DockerError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'DockerError';
  }
}

export class DockerRuntime {
  static isAvailable(): boolean {
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

  /**
   * Create + start a container for a task.
   */
  async create(spec: ContainerSpec): Promise<ContainerHandle> {
    const image = spec.image ?? process.env.WORKBENCH_RUNTIME_IMAGE ?? 'node:22-bookworm-slim';
    const name = `wb-${spec.taskId.slice(0, 12)}`;

    const args = [
      'run', '-d',
      '--name', name,
      '-v', `${spec.worktreePath}:/workspace`,
      '-w', '/workspace',
      '--label', `workbench.task=${spec.taskId}`,
    ];

    // Env vars
    for (const [k, v] of Object.entries(spec.envVars ?? {})) {
      args.push('-e', `${k}=${v}`);
    }

    // Ports
    for (const lease of spec.ports ?? []) {
      args.push('-p', `${lease.port}:${lease.port}/${lease.protocol}`);
    }

    // Keep container alive — sleep infinity so we can exec into it
    args.push(image, 'sh', '-c', 'tail -f /dev/null');

    try {
      const { stdout } = await execFileAsync('docker', args);
      const containerId = stdout.trim();

      // Provision agent CLI if requested
      let agentProvisioned = false;
      if (spec.agent) {
        agentProvisioned = await this.provisionAgent(containerId, spec.agent);
      }

      return {
        id: containerId,
        name,
        image,
        startedAt: new Date().toISOString(),
        agentProvisioned,
      };
    } catch (err) {
      throw new DockerError(
        'CONTAINER_CREATE_FAILED',
        `docker run failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Install agent CLI inside the container via npm.
   * Returns true if successful.
   */
  async provisionAgent(containerId: string, agent: 'claude' | 'codex' | 'copilot'): Promise<boolean> {
    const pkg = AGENT_NPM_PACKAGES[agent];
    if (!pkg) return false;

    // Install globally so it's on PATH
    const result = await this.exec(containerId, ['npm', 'install', '-g', pkg], {
      env: { npm_config_loglevel: 'error' },
    });

    if (result.exitCode !== 0) {
      return false;
    }

    // Verify installation
    const verify = await this.exec(containerId, [agent, '--version']);
    return verify.exitCode === 0;
  }

  /**
   * Execute a command inside the container.
   * Returns exit code, stdout, stderr.
   */
  async exec(containerId: string, command: string[], opts?: { env?: Record<string, string> }): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const args = ['exec'];
    for (const [k, v] of Object.entries(opts?.env ?? {})) {
      args.push('-e', `${k}=${v}`);
    }
    args.push(containerId, ...command);

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

  /**
   * Stop and remove the container.
   */
  async destroy(containerId: string): Promise<void> {
    try {
      await execFileAsync('docker', ['rm', '-f', containerId]);
    } catch {
      // Container already gone
    }
  }

  /**
   * Check if a container is running.
   */
  async isRunning(containerId: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('docker', ['inspect', '-f', '{{.State.Running}}', containerId]);
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }
}
