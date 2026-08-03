/**
 * Claude agent provider — Launches the `claude` CLI for a task.
 *
 * Auto-approve gating:
 *   - When autoApprove=true, launches with --permission-mode acceptEdits
 *     and a derived --allowed-tools list scoped to the worktree.
 *   - When autoApprove=false, launches in interactive mode (default permission prompt).
 */

import { execFileSync, spawn } from 'node:child_process';
import type { AgentProvider, AgentLaunchSpec, AgentSession } from './types.js';

export class ClaudeProvider implements AgentProvider {
  readonly name = 'claude' as const;

  isAvailable(): boolean {
    try {
      execFileSync('claude', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  async launch(spec: AgentLaunchSpec): Promise<AgentSession> {
    const args = this.buildArgs(spec);
    const env = { ...process.env, ...spec.envVars };

    if (spec.containerId) {
      return this.launchInContainer(spec, args, env);
    }

    return this.launchOnHost(spec, args, env);
  }

  private buildArgs(spec: AgentLaunchSpec): string[] {
    const args: string[] = [];

    if (spec.autoApprove) {
      args.push('--permission-mode', 'acceptEdits');
      // Limit to safe tools by default; expand via skill manifests
      args.push('--allowed-tools', 'Read,Edit,Write,Bash,Glob,Grep');
    }

    // Working directory
    args.push('--cwd', spec.worktreePath);

    if (spec.prompt) {
      args.push(spec.prompt);
    }

    return args;
  }

  private async launchOnHost(
    spec: AgentLaunchSpec, args: string[], env: NodeJS.ProcessEnv,
  ): Promise<AgentSession> {
    const child = spawn('claude', args, {
      cwd: spec.worktreePath,
      env,
      stdio: 'inherit',
      detached: false,
    });

    return {
      taskId: spec.taskId,
      provider: 'claude',
      pid: child.pid,
      startedAt: new Date().toISOString(),
    };
  }

  private async launchInContainer(
    spec: AgentLaunchSpec, args: string[], env: NodeJS.ProcessEnv,
  ): Promise<AgentSession> {
    const dockerArgs = ['exec', '-it'];

    // Pass through env vars from launchSpec only (not the whole host env)
    for (const [k, v] of Object.entries(spec.envVars ?? {})) {
      dockerArgs.push('-e', `${k}=${v}`);
    }

    dockerArgs.push(spec.containerId!, 'claude', ...args);

    const child = spawn('docker', dockerArgs, {
      stdio: 'inherit',
      env,
      detached: false,
    });

    return {
      taskId: spec.taskId,
      provider: 'claude',
      pid: child.pid,
      containerId: spec.containerId,
      startedAt: new Date().toISOString(),
    };
  }
}
