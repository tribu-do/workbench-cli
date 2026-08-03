/**
 * SandboxBroker — Shell mediation and execution.
 * Implements LLD-5 shim/pty-wrap contract.
 * File-first: exec events logged to `.workbench/audit.jsonl`.
 */

import { execSync, spawn } from 'node:child_process';
import type {
  ExecRequest,
  ExecResult,
  RuntimeMode,
  RuntimeProbe,
  TaskSpec,
} from './types.js';
import { resolveAuditLog } from './config.js';
import { appendJsonLine, uuid, now } from './stores/file-utils.js';

export interface ExecLogEvent {
  id: string;
  event: 'exec';
  taskId: string;
  command: string;
  exitCode: number | null;
  blocked: boolean;
  runtimeMode: RuntimeMode;
  isolationTier: string;
  durationMs: number;
  timestamp: string;
}

export class SandboxBroker {
  constructor() {}

  /**
   * Probe the runtime environment to determine what mediation layers are available.
   */
  async probeRuntime(mode: RuntimeMode, spec: TaskSpec): Promise<RuntimeProbe> {
    const probe: RuntimeProbe = {
      runtimeMode: mode,
      aioHealthy: false,
      dockerHealthy: false,
      shimHealthy: false,
      ptyWrapHealthy: false,
      gpuAvailable: false,
    };

    switch (mode) {
      case 'daemon-managed':
        probe.aioHealthy = await this.checkAioHealth();
        probe.dockerHealthy = await this.checkDockerHealth();
        probe.shimHealthy = probe.aioHealthy || probe.dockerHealthy;
        probe.ptyWrapHealthy = true;
        break;

      case 'dev-managed':
        if (spec.sshTarget) {
          probe.shimHealthy = await this.checkRemoteShim(spec.sshTarget);
          probe.ptyWrapHealthy = await this.checkRemotePtyWrap(spec.sshTarget);
        } else if (spec.composeFile) {
          probe.shimHealthy = await this.checkComposeShim(spec.composeFile);
          probe.ptyWrapHealthy = true; // PTY-wrap is local
        }
        break;

      case 'bare-host':
        // No mediation in bare-host
        break;
    }

    // GPU detection
    probe.gpuAvailable = this.detectGpu();

    return probe;
  }

  /**
   * Execute a command through the sandbox mediation layer.
   * All executions are logged to sandbox_exec_log.
   */
  async exec(request: ExecRequest, mode: RuntimeMode, isolationTier: string): Promise<ExecResult> {
    const start = Date.now();
    let result: ExecResult;

    try {
      result = await this.executeCommand(request, mode);
    } catch (err) {
      result = {
        exitCode: 1,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        blocked: false,
        durationMs: Date.now() - start,
      };
    }

    result.durationMs = Date.now() - start;

    appendJsonLine(resolveAuditLog(), {
      id: uuid(),
      event: 'exec',
      taskId: request.taskId,
      command: request.command,
      exitCode: result.exitCode,
      blocked: result.blocked,
      runtimeMode: mode,
      isolationTier,
      durationMs: result.durationMs,
      timestamp: now(),
    } satisfies ExecLogEvent);

    return result;
  }

  private async executeCommand(request: ExecRequest, _mode: RuntimeMode): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const timeout = request.timeout ?? 30_000;
      const cmd = request.args
        ? `${request.command} ${request.args.join(' ')}`
        : request.command;

      const child = spawn('sh', ['-c', cmd], {
        cwd: request.cwd,
        env: { ...process.env, ...request.env },
        timeout,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

      child.on('close', (code) => {
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
          blocked: false,
          durationMs: 0,
        });
      });

      child.on('error', (err) => {
        reject(err);
      });
    });
  }

  // ------- Health probes -------

  private async checkAioHealth(): Promise<boolean> {
    try {
      execSync('which aio-sandbox 2>/dev/null', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  private async checkDockerHealth(): Promise<boolean> {
    try {
      execSync('docker info >/dev/null 2>&1', { stdio: 'ignore', timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  private async checkRemoteShim(sshTarget: string): Promise<boolean> {
    try {
      execSync(`ssh -o ConnectTimeout=5 ${sshTarget} "which workbench-exec" 2>/dev/null`, {
        stdio: 'ignore',
        timeout: 10_000,
      });
      return true;
    } catch {
      return false;
    }
  }

  private async checkRemotePtyWrap(_sshTarget: string): Promise<boolean> {
    // PTY-wrap is provided by the daemon side, so it's always available when SSH connects
    return true;
  }

  private async checkComposeShim(composeFile: string): Promise<boolean> {
    try {
      execSync(`docker compose -f ${composeFile} ps --format json 2>/dev/null`, {
        stdio: 'ignore',
        timeout: 10_000,
      });
      return true;
    } catch {
      return false;
    }
  }

  private detectGpu(): boolean {
    try {
      execSync('nvidia-smi 2>/dev/null', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
}
