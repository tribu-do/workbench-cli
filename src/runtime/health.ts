/**
 * Runtime Health — Truth model for container/process/agent state.
 * File-first: reads task state from file store, port leases from leases.jsonl.
 *
 * Provides real-time status checks:
 *   - Container running state (docker inspect)
 *   - Agent process liveness (PID check)
 *   - Port availability
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Task } from '../types.js';
import { Orchestrator } from '../orchestrator.js';
import { PortAllocator } from '../port-allocator.js';

export interface ContainerHealth {
  exists: boolean;
  running: boolean;
  status?: string;
  startedAt?: string;
  health?: 'healthy' | 'unhealthy' | 'starting' | 'none';
  image?: string;
  ports?: Array<{ host: number; container: number; protocol: string }>;
}

export interface AgentHealth {
  running: boolean;
  pid?: number;
  startedAt?: string;
  agent?: 'claude' | 'codex' | 'copilot';
}

export interface PortHealth {
  port: number;
  inUse: boolean;
  byWorkbench: boolean;
  process?: string;
}

export interface TaskHealthReport {
  task: Task;
  dbState: string;
  container?: ContainerHealth;
  agent?: AgentHealth;
  ports: PortHealth[];
  worktree: {
    exists: boolean;
    path?: string;
    clean?: boolean;
  };
  discrepancies: string[];
}

export class HealthChecker {
  constructor(
    private orchestrator: Orchestrator,
    private portAllocator: PortAllocator,
  ) {}

  async checkTask(task: Task): Promise<TaskHealthReport> {
    const discrepancies: string[] = [];

    let container: ContainerHealth | undefined;
    if (task.metadata.containerId) {
      container = this.checkContainer(task.metadata.containerId as string);

      if (task.state === 'running' && !container.running) {
        discrepancies.push('Task state is "running" but container is not running');
      }
      if (task.state === 'aborted' && container.running) {
        discrepancies.push('Task state is "aborted" but container is still running');
      }
    }

    let agent: AgentHealth | undefined;
    const agentPidFile = path.join(process.cwd(), '.workbench/agent-pids', `${task.sessionId}.json`);
    if (fs.existsSync(agentPidFile)) {
      try {
        const agentData = JSON.parse(fs.readFileSync(agentPidFile, 'utf-8'));
        if (agentData.taskId === task.id) {
          agent = {
            running: this.isProcessRunning(agentData.pid),
            pid: agentData.pid,
            startedAt: agentData.startedAt,
            agent: agentData.agent,
          };

          if (task.state === 'running' && !agent.running) {
            discrepancies.push('Task state is "running" but agent process is not running');
          }
        }
      } catch {
        // Ignore parse errors
      }
    }

    const ports = await this.checkPorts(task.sessionId);

    const worktreePath = task.metadata.worktreePath as string | undefined;
    const worktree = {
      exists: worktreePath ? fs.existsSync(worktreePath) : false,
      path: worktreePath,
      clean: worktreePath ? this.isWorktreeClean(worktreePath) : undefined,
    };

    if (task.state === 'running' && worktreePath && !worktree.exists) {
      discrepancies.push('Task state is "running" but worktree does not exist');
    }

    return {
      task,
      dbState: task.state,
      container,
      agent,
      ports,
      worktree,
      discrepancies,
    };
  }

  checkContainer(containerId: string): ContainerHealth {
    try {
      const output = execSync(
        `docker inspect --format '{{json .}}' ${containerId}`,
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
      );

      const info = JSON.parse(output);

      const ports: Array<{ host: number; container: number; protocol: string }> = [];
      const portBindings = info.HostConfig?.PortBindings ?? {};
      for (const [containerPort, bindings] of Object.entries(portBindings)) {
        const [port, protocol] = containerPort.split('/');
        for (const binding of (bindings as Array<{ HostPort: string }>) ?? []) {
          ports.push({
            host: parseInt(binding.HostPort, 10),
            container: parseInt(port, 10),
            protocol: protocol ?? 'tcp',
          });
        }
      }

      return {
        exists: true,
        running: info.State?.Running ?? false,
        status: info.State?.Status,
        startedAt: info.State?.StartedAt,
        health: info.State?.Health?.Status ?? 'none',
        image: info.Config?.Image,
        ports,
      };
    } catch {
      return {
        exists: false,
        running: false,
      };
    }
  }

  isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async checkPorts(sessionId: string): Promise<PortHealth[]> {
    const leases = this.portAllocator.list({ sessionId });
    const results: PortHealth[] = [];

    for (const lease of leases) {
      const inUse = this.isPortInUse(lease.port);
      const byWorkbench = inUse && this.isPortUsedByWorkbench(lease.port);

      results.push({
        port: lease.port,
        inUse,
        byWorkbench,
        process: inUse ? this.getPortProcess(lease.port) : undefined,
      });
    }

    return results;
  }

  isPortInUse(port: number): boolean {
    try {
      execSync(`lsof -i :${port}`, { stdio: ['ignore', 'ignore', 'ignore'] });
      return true;
    } catch {
      return false;
    }
  }

  isPortUsedByWorkbench(port: number): boolean {
    try {
      const output = execSync(
        `docker ps --filter "publish=${port}" --format "{{.Names}}"`,
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      return output.includes('wb-');
    } catch {
      return false;
    }
  }

  getPortProcess(port: number): string | undefined {
    try {
      const output = execSync(
        `lsof -i :${port} -t | head -1 | xargs ps -p -o comm=`,
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      return output.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  isWorktreeClean(worktreePath: string): boolean {
    try {
      const output = execSync('git status --porcelain', {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return output.trim() === '';
    } catch {
      return true;
    }
  }

  async checkAllTasks(): Promise<TaskHealthReport[]> {
    const tasks = this.orchestrator.listTasks().filter(
      t => t.state !== 'merged' && t.state !== 'aborted'
    );

    const reports: TaskHealthReport[] = [];
    for (const task of tasks) {
      reports.push(await this.checkTask(task));
    }

    return reports;
  }
}

export function formatHealthReport(report: TaskHealthReport): string {
  const lines: string[] = [];

  lines.push(`Task: ${report.task.name} (${report.task.id})`);
  lines.push(`  State: ${report.dbState}`);

  if (report.container) {
    lines.push('  Container:');
    lines.push(`    Running: ${report.container.running ? 'yes' : 'no'}`);
    if (report.container.status) {
      lines.push(`    Status:  ${report.container.status}`);
    }
    if (report.container.image) {
      lines.push(`    Image:   ${report.container.image}`);
    }
    if (report.container.ports && report.container.ports.length > 0) {
      lines.push(`    Ports:   ${report.container.ports.map((p) => `${p.host}:${p.container}`).join(', ')}`);
    }
  }

  if (report.agent) {
    lines.push('  Agent:');
    lines.push(`    Running: ${report.agent.running ? 'yes' : 'no'}`);
    if (report.agent.pid) {
      lines.push(`    PID:     ${report.agent.pid}`);
    }
    if (report.agent.agent) {
      lines.push(`    Type:    ${report.agent.agent}`);
    }
  }

  if (report.ports.length > 0) {
    lines.push('  Ports:');
    for (const p of report.ports) {
      const status = p.inUse ? (p.byWorkbench ? 'in use (workbench)' : `in use (${p.process ?? 'other'})`) : 'available';
      lines.push(`    ${p.port}: ${status}`);
    }
  }

  lines.push('  Worktree:');
  lines.push(`    Exists: ${report.worktree.exists ? 'yes' : 'no'}`);
  if (report.worktree.path) {
    lines.push(`    Path:   ${report.worktree.path}`);
  }
  if (report.worktree.clean !== undefined) {
    lines.push(`    Clean:  ${report.worktree.clean ? 'yes' : 'no'}`);
  }

  if (report.discrepancies.length > 0) {
    lines.push('  Discrepancies:');
    for (const d of report.discrepancies) {
      lines.push(`    - ${d}`);
    }
  }

  return lines.join('\n');
}
