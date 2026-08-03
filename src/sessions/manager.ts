/**
 * SessionManager — Durable session orchestration with detach/attach/resume.
 * File-first: no SQLite dependency.
 *
 * Key features:
 *   - Background agent processes that survive terminal detach
 *   - tmux-like attach/detach semantics
 *   - Session state persistence across CLI invocations
 *   - Memory extraction on session end
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Session, Task, RuntimeMode } from '../types.js';
import { SessionService } from './service.js';
import { Orchestrator } from '../orchestrator.js';
import { getBackend, type RuntimeBackend, type RuntimeHandle } from '../runtime/backends.js';
import { getMemoryBackend, type MemoryBackend } from '../memory/backends.js';

const AGENT_PID_DIR = '.workbench/agent-pids';
const RUNTIME_HANDLES_FILE = '.workbench/runtime-handles.json';

export interface AgentProcess {
  taskId: string;
  sessionId: string;
  pid: number;
  agent: 'claude' | 'codex' | 'copilot';
  startedAt: string;
  containerId?: string;
}

export interface SessionRuntime {
  sessionId: string;
  handle: RuntimeHandle;
  agentProcess?: AgentProcess;
}

export class SessionManager {
  private sessionService: SessionService;
  private runtimeBackend: RuntimeBackend;
  private memoryBackend: MemoryBackend;

  constructor(private orchestrator: Orchestrator) {
    this.sessionService = new SessionService();
    this.runtimeBackend = getBackend();
    this.memoryBackend = getMemoryBackend();
  }

  async createSession(spec: {
    workspaceId: string;
    name?: string;
    runtimeMode: RuntimeMode;
    agent?: 'claude' | 'codex' | 'copilot';
  }): Promise<Session> {
    const session = this.sessionService.create(spec);
    this.sessionService.attach(session.id);
    return session;
  }

  async attachSession(sessionId: string): Promise<{
    session: Session;
    agentRunning: boolean;
    containerId?: string;
  }> {
    const session = this.sessionService.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    if (session.state === 'ended') {
      throw new Error(`Session ${sessionId} has ended`);
    }

    this.sessionService.attach(sessionId);

    const agentProcess = this.getAgentProcess(sessionId);
    const agentRunning = agentProcess ? this.isProcessRunning(agentProcess.pid) : false;

    const handle = this.getRuntimeHandle(sessionId);

    return {
      session,
      agentRunning,
      containerId: handle?.handle.containerId,
    };
  }

  async detachSession(sessionId: string): Promise<void> {
    const session = this.sessionService.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    if (session.state === 'active') {
      this.sessionService.transition(sessionId, 'paused');
    }

    const currentFile = path.join(process.cwd(), '.workbench/current-session');
    if (fs.existsSync(currentFile)) {
      const currentId = fs.readFileSync(currentFile, 'utf-8').trim();
      if (currentId === sessionId) {
        fs.unlinkSync(currentFile);
      }
    }
  }

  async resumeSession(sessionId: string, prompt?: string): Promise<{
    session: Session;
    agentRestarted: boolean;
  }> {
    const session = this.sessionService.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    if (session.state === 'ended') {
      throw new Error(`Session ${sessionId} has ended`);
    }

    this.sessionService.attach(sessionId);

    if (session.state === 'paused') {
      this.sessionService.transition(sessionId, 'active');
    }

    const agentProcess = this.getAgentProcess(sessionId);
    const agentRunning = agentProcess ? this.isProcessRunning(agentProcess.pid) : false;

    if (agentRunning && prompt) {
      console.log(`Agent is running (PID ${agentProcess!.pid}). Use 'workbench session enter' to interact.`);
    }

    return {
      session: this.sessionService.get(sessionId)!,
      agentRestarted: !agentRunning,
    };
  }

  async launchAgent(
    task: Task,
    options: {
      prompt?: string;
      autoApprove: boolean;
      detached: boolean;
    },
  ): Promise<AgentProcess | null> {
    const session = this.sessionService.get(task.sessionId);
    if (!session) {
      throw new Error(`Session ${task.sessionId} not found`);
    }

    let runtime = this.getRuntimeHandle(task.sessionId);

    if (!runtime && task.metadata.containerId) {
      runtime = {
        sessionId: task.sessionId,
        handle: {
          backend: 'docker',
          containerId: task.metadata.containerId as string,
          name: `wb-${task.id.slice(0, 12)}`,
          startedAt: task.createdAt,
          agentProvisioned: true,
        },
      };
      this.saveRuntimeHandle(runtime);
    }

    if (!runtime) {
      throw new Error('No runtime container available for this task');
    }

    const child = await this.runtimeBackend.attach(runtime.handle, {
      prompt: options.prompt,
      autoApprove: options.autoApprove,
      interactive: !options.detached,
    });

    if (!child) {
      return null;
    }

    const agentProcess: AgentProcess = {
      taskId: task.id,
      sessionId: task.sessionId,
      pid: child.pid!,
      agent: session.agent,
      startedAt: new Date().toISOString(),
      containerId: runtime.handle.containerId,
    };

    this.saveAgentProcess(agentProcess);

    if (options.detached) {
      child.unref();
    }

    return agentProcess;
  }

  async stopSession(
    sessionId: string,
    options?: { extractMemory?: boolean; feedback?: string },
  ): Promise<{ session: Session; tasksAborted: number; memoriesExtracted: number }> {
    const session = this.sessionService.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const agentProcess = this.getAgentProcess(sessionId);
    if (agentProcess && this.isProcessRunning(agentProcess.pid)) {
      try {
        process.kill(agentProcess.pid, 'SIGTERM');
      } catch {
        // Process may have already exited
      }
    }
    this.removeAgentProcess(sessionId);

    const runtime = this.getRuntimeHandle(sessionId);
    if (runtime) {
      await this.runtimeBackend.destroy(runtime.handle);
      this.removeRuntimeHandle(sessionId);
    }

    let memoriesExtracted = 0;
    if (options?.extractMemory) {
      try {
        const tasks = this.orchestrator.listTasks({ sessionId });
        const taskSummary = tasks
          .map((t) => `Task: ${t.name} (${t.state})`)
          .join('\n');

        const result = await this.memoryBackend.extractFromSession(
          sessionId,
          taskSummary,
          options.feedback,
        );

        memoriesExtracted =
          result.userMemories.length +
          result.agentExperiences.length +
          result.sessionContext.length;
      } catch (err) {
        console.warn('Memory extraction failed:', err);
      }
    }

    // Abort active tasks in this session
    const activeTasks = this.orchestrator.listTasks({ sessionId }).filter(
      t => t.state !== 'merged' && t.state !== 'aborted'
    );
    for (const task of activeTasks) {
      try {
        this.orchestrator.transitionTask(task.id, 'aborted');
      } catch {
        // Ignore transition errors
      }
    }

    const { session: endedSession } = this.sessionService.stop(sessionId);

    return { session: endedSession, tasksAborted: activeTasks.length, memoriesExtracted };
  }

  getAgentStatus(sessionId: string): {
    running: boolean;
    process?: AgentProcess;
    containerRunning?: boolean;
  } {
    const agentProcess = this.getAgentProcess(sessionId);
    const running = agentProcess ? this.isProcessRunning(agentProcess.pid) : false;

    const runtime = this.getRuntimeHandle(sessionId);
    let containerRunning: boolean | undefined;

    if (runtime?.handle.containerId) {
      try {
        const result = execSync(
          `docker inspect -f '{{.State.Running}}' ${runtime.handle.containerId}`,
          { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
        );
        containerRunning = result.trim() === 'true';
      } catch {
        containerRunning = false;
      }
    }

    return { running, process: agentProcess ?? undefined, containerRunning };
  }

  enterSession(sessionId: string): ChildProcess | null {
    const runtime = this.getRuntimeHandle(sessionId);
    if (!runtime?.handle.containerId) {
      return null;
    }

    return spawn('docker', ['exec', '-it', runtime.handle.containerId, '/bin/bash'], {
      stdio: 'inherit',
    });
  }

  private getAgentProcess(sessionId: string): AgentProcess | null {
    const pidFile = path.join(process.cwd(), AGENT_PID_DIR, `${sessionId}.json`);
    if (!fs.existsSync(pidFile)) return null;

    try {
      return JSON.parse(fs.readFileSync(pidFile, 'utf-8')) as AgentProcess;
    } catch {
      return null;
    }
  }

  private saveAgentProcess(agentProc: AgentProcess): void {
    const dir = path.join(process.cwd(), AGENT_PID_DIR);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const pidFile = path.join(dir, `${agentProc.sessionId}.json`);
    fs.writeFileSync(pidFile, JSON.stringify(agentProc, null, 2));
  }

  private removeAgentProcess(sessionId: string): void {
    const pidFile = path.join(process.cwd(), AGENT_PID_DIR, `${sessionId}.json`);
    if (fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
  }

  private isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private getRuntimeHandle(sessionId: string): SessionRuntime | null {
    const handlesFile = path.join(process.cwd(), RUNTIME_HANDLES_FILE);
    if (!fs.existsSync(handlesFile)) return null;

    try {
      const handles = JSON.parse(fs.readFileSync(handlesFile, 'utf-8')) as Record<string, SessionRuntime>;
      return handles[sessionId] ?? null;
    } catch {
      return null;
    }
  }

  private saveRuntimeHandle(runtime: SessionRuntime): void {
    const handlesFile = path.join(process.cwd(), RUNTIME_HANDLES_FILE);
    let handles: Record<string, SessionRuntime> = {};

    if (fs.existsSync(handlesFile)) {
      try {
        handles = JSON.parse(fs.readFileSync(handlesFile, 'utf-8'));
      } catch {
        // Ignore parse errors
      }
    }

    handles[runtime.sessionId] = runtime;
    fs.writeFileSync(handlesFile, JSON.stringify(handles, null, 2));
  }

  private removeRuntimeHandle(sessionId: string): void {
    const handlesFile = path.join(process.cwd(), RUNTIME_HANDLES_FILE);
    if (!fs.existsSync(handlesFile)) return;

    try {
      const handles = JSON.parse(fs.readFileSync(handlesFile, 'utf-8')) as Record<string, SessionRuntime>;
      delete handles[sessionId];
      fs.writeFileSync(handlesFile, JSON.stringify(handles, null, 2));
    } catch {
      // Ignore errors
    }
  }
}
