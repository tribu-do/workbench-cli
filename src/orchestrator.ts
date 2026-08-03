/**
 * Orchestrator — Task lifecycle management.
 * Implements the state machine from LLD-1 plus end-to-end provisioning:
 * worktree → ports (default-allocate) → secrets (resolve+inject) → container.
 * File-first: tasks stored as YAML files, events in JSON Lines.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type {
  Task,
  TaskSpec,
  TaskState,
  TaskEvent,
  RuntimeMode,
  IsolationTier,
  PortSpec,
  PortRequest,
  WorkbenchConfig,
} from './types.js';
import { resolveWorkbenchDir } from './config.js';
import { PolicyEngine } from './policy-engine.js';
import { PortAllocator } from './port-allocator.js';
import { SecretManager, SecretPolicy } from './secret-manager.js';
import { SandboxBroker } from './sandbox-broker.js';
import { SessionService } from './sessions/service.js';
import { createWorktree, removeWorktree, findRepoRoot, isGitRepo } from './runtime/worktree.js';
import { DockerRuntime } from './runtime/docker.js';
import { appendJsonLine, uuid, now } from './stores/file-utils.js';

const TRANSITIONS: Record<TaskState, TaskState[]> = {
  pending: ['provisioning_runtime', 'aborted'],
  provisioning_runtime: ['running', 'downgraded', 'aborted'],
  running: ['suspended', 'ready_for_review', 'merged', 'aborted'],
  downgraded: ['running', 'suspended', 'ready_for_review', 'merged', 'aborted'],
  suspended: ['running', 'aborted'],
  ready_for_review: ['running', 'merged', 'aborted'],
  merged: [],
  aborted: [],
};

interface StoredTask {
  id: string;
  name: string;
  branch: string;
  workspaceId: string;
  sessionId: string;
  state: TaskState;
  runtimeMode: RuntimeMode;
  isolationTier: IsolationTier;
  aiAgentProvider: string;
  autoApprove: boolean;
  metadata: Record<string, unknown>;
  worktreePath?: string;
  containerId?: string;
  createdAt: string;
  updatedAt: string;
}

export class Orchestrator {
  private docker = new DockerRuntime();

  constructor(
    private config: WorkbenchConfig,
    private policyEngine: PolicyEngine,
    private portAllocator: PortAllocator,
    private secretManager: SecretManager,
    private secretPolicy: SecretPolicy,
    private sandboxBroker: SandboxBroker,
    private sessionService: SessionService,
  ) {}

  private resolveTasksDir(): string {
    return path.join(resolveWorkbenchDir(), 'tasks');
  }

  private taskPath(id: string): string {
    return path.join(this.resolveTasksDir(), `${id}.yaml`);
  }

  private eventsPath(id: string): string {
    return path.join(this.resolveTasksDir(), id, 'events.jsonl');
  }

  private readTaskFile(filePath: string): StoredTask | null {
    if (!fs.existsSync(filePath)) return null;
    try {
      return parseYaml(fs.readFileSync(filePath, 'utf-8')) as StoredTask;
    } catch {
      return null;
    }
  }

  private writeTaskFile(stored: StoredTask): void {
    const filePath = this.taskPath(stored.id);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, stringifyYaml(stored, { indent: 2 }), 'utf-8');
  }

  private storedToTask(stored: StoredTask): Task {
    return {
      id: stored.id,
      name: stored.name,
      branch: stored.branch,
      workspaceId: stored.workspaceId,
      sessionId: stored.sessionId,
      state: stored.state,
      runtimeMode: stored.runtimeMode,
      isolationTier: stored.isolationTier,
      aiAgentProvider: stored.aiAgentProvider,
      autoApprove: stored.autoApprove,
      metadata: {
        ...stored.metadata,
        worktreePath: stored.worktreePath,
        containerId: stored.containerId,
      },
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
    };
  }

  async createTask(spec: TaskSpec): Promise<Task> {
    const id = spec.id ?? uuid();
    const timestamp = now();
    const runtimeMode = spec.runtimeMode ?? this.config.runtime.mode;
    const branch = spec.branch ?? `wb-tasks/${id.slice(0, 8)}`;
    const workspaceId = spec.workspaceId ?? this.config.workspace.id ?? 'default';

    const session = spec.sessionId
      ? this.sessionService.get(spec.sessionId)
      : this.sessionService.getOrCreateCurrent(workspaceId, runtimeMode);
    if (!session) {
      throw new OrchestratorError('SESSION_NOT_FOUND', `Session ${spec.sessionId} not found`);
    }
    const sessionId = session.id;

    const provider = spec.aiAgentProvider ?? session.agent ?? 'claude';

    const probe = await this.sandboxBroker.probeRuntime(runtimeMode, spec);
    const verdict = this.policyEngine.evaluate(spec, probe);

    const requestedAutoApprove = spec.autoApprove !== false;
    const effectiveAutoApprove = requestedAutoApprove && verdict.effectiveAutoApprove;
    const initialState: TaskState =
      requestedAutoApprove && !effectiveAutoApprove ? 'downgraded' : 'running';

    if (spec.secrets && spec.secrets.length > 0) {
      const secretVerdict = this.secretPolicy.evaluate(spec, probe);
      if (!secretVerdict.enforceable) {
        throw new OrchestratorError(
          'SECRET_POLICY_UNENFORCEABLE',
          `Cannot inject secrets in ${runtimeMode} mode: ${secretVerdict.reasons.join('; ')}`,
        );
      }
      if (secretVerdict.deniedKeys.length > 0) {
        throw new OrchestratorError(
          'SECRET_DENIED',
          `Denied secret keys: ${secretVerdict.deniedKeys.join(', ')}`,
        );
      }
    }

    const stored: StoredTask = {
      id,
      name: spec.name,
      branch,
      workspaceId,
      sessionId,
      state: 'provisioning_runtime',
      runtimeMode,
      isolationTier: verdict.isolationTier,
      aiAgentProvider: provider,
      autoApprove: effectiveAutoApprove,
      metadata: spec.metadata ?? {},
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.writeTaskFile(stored);

    const portRequests = this.normalizePortRequests(spec.ports);
    const portLeases = await this.portAllocator.reserve(sessionId, portRequests);

    let resolvedEnvVars: Record<string, string> = {};
    if (spec.secrets && spec.secrets.length > 0) {
      const secretVerdict = this.secretPolicy.evaluate(spec, probe);
      const resolved = this.secretManager.resolve(
        { taskId: id, sessionId, workspaceId },
        spec.secrets,
        provider,
      );
      for (const [k, v] of resolved.secrets) resolvedEnvVars[k] = v;

      this.emitEvent(id, 'secret.policy.decision', {
        injectionMethod: secretVerdict.injectionMethod,
        keysGranted: Array.from(resolved.secrets.keys()),
        keysRequested: spec.secrets,
      });
    }

    this.emitEvent(id, 'task.provisioning', {
      runtimeMode,
      isolationTier: verdict.isolationTier,
      autoApproveRequested: requestedAutoApprove,
      autoApproveEffective: effectiveAutoApprove,
      ports: portLeases.map(l => ({ name: l.name, port: l.port })),
      secretsGranted: Object.keys(resolvedEnvVars),
      policyReasons: verdict.reasons,
    });

    let worktreePath: string | undefined;
    const repoRoot = findRepoRoot();
    if (repoRoot && isGitRepo(repoRoot)) {
      try {
        worktreePath = createWorktree({ repoRoot, taskId: id, branch });
        stored.worktreePath = worktreePath;
        this.writeTaskFile(stored);
        this.emitEvent(id, 'worktree.created', { path: worktreePath, branch });
      } catch (err) {
        this.emitEvent(id, 'worktree.failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    let containerId: string | undefined;
    if (runtimeMode === 'daemon-managed' && DockerRuntime.isAvailable() && worktreePath) {
      const portEnv: Record<string, string> = {};
      for (const lease of portLeases) {
        portEnv[`WORKBENCH_PORT_${lease.name.toUpperCase()}`] = String(lease.port);
      }

      const agentEnv: Record<string, string> = {};
      const agentKey = provider === 'claude' ? 'ANTHROPIC_API_KEY'
        : provider === 'codex' ? 'OPENAI_API_KEY'
        : provider === 'copilot' ? 'GITHUB_TOKEN' : null;
      if (agentKey && process.env[agentKey]) {
        agentEnv[agentKey] = process.env[agentKey]!;
      }

      try {
        const handle = await this.docker.create({
          taskId: id,
          worktreePath,
          envVars: { ...portEnv, ...agentEnv, ...resolvedEnvVars },
          ports: portLeases,
          agent: provider as 'claude' | 'codex' | 'copilot',
        });
        containerId = handle.id;
        stored.containerId = containerId;
        this.writeTaskFile(stored);
        this.emitEvent(id, 'container.created', {
          containerId,
          image: handle.image,
          agentProvisioned: handle.agentProvisioned,
        });
      } catch (err) {
        this.emitEvent(id, 'container.failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    this.transitionTask(id, initialState);

    return this.getTask(id)!;
  }

  transitionTask(taskId: string, newState: TaskState): Task {
    const task = this.getTask(taskId);
    if (!task) throw new OrchestratorError('TASK_NOT_FOUND', `Task ${taskId} not found`);

    const allowed = TRANSITIONS[task.state];
    if (!allowed.includes(newState)) {
      throw new OrchestratorError(
        'INVALID_TRANSITION',
        `Cannot transition from ${task.state} to ${newState}`,
      );
    }

    const timestamp = now();
    const stored = this.readTaskFile(this.taskPath(taskId))!;
    stored.state = newState;
    stored.updatedAt = timestamp;
    this.writeTaskFile(stored);

    this.emitEvent(taskId, 'task.state_changed', { from: task.state, to: newState });

    if (newState === 'merged' || newState === 'aborted') {
      this.cleanupTaskResources(taskId).catch(() => { /* logged via events */ });
    }

    return { ...task, state: newState, updatedAt: timestamp };
  }

  async cleanupTaskResources(taskId: string): Promise<void> {
    const stored = this.readTaskFile(this.taskPath(taskId));
    if (!stored) return;

    this.portAllocator.release(stored.sessionId);

    if (stored.containerId && DockerRuntime.isAvailable()) {
      try {
        await this.docker.destroy(stored.containerId);
        this.emitEvent(taskId, 'container.destroyed', { containerId: stored.containerId });
      } catch (err) {
        this.emitEvent(taskId, 'container.destroy_failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (stored.worktreePath) {
      const repoRoot = findRepoRoot();
      if (repoRoot) {
        try {
          removeWorktree({ repoRoot, worktreePath: stored.worktreePath });
          this.emitEvent(taskId, 'worktree.removed', { path: stored.worktreePath });
        } catch (err) {
          this.emitEvent(taskId, 'worktree.remove_failed', { error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  }

  getTask(taskId: string): Task | null {
    const stored = this.readTaskFile(this.taskPath(taskId));
    if (!stored) return null;
    return this.storedToTask(stored);
  }

  listTasks(filter?: { state?: TaskState; workspaceId?: string; sessionId?: string }): Task[] {
    const tasksDir = this.resolveTasksDir();
    if (!fs.existsSync(tasksDir)) return [];

    const results: Task[] = [];

    for (const file of fs.readdirSync(tasksDir)) {
      if (!file.endsWith('.yaml')) continue;
      const stored = this.readTaskFile(path.join(tasksDir, file));
      if (!stored) continue;

      if (filter?.state && stored.state !== filter.state) continue;
      if (filter?.workspaceId && stored.workspaceId !== filter.workspaceId) continue;
      if (filter?.sessionId && stored.sessionId !== filter.sessionId) continue;

      results.push(this.storedToTask(stored));
    }

    return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getEvents(taskId: string): TaskEvent[] {
    const eventsFile = this.eventsPath(taskId);
    if (!fs.existsSync(eventsFile)) return [];

    const results: TaskEvent[] = [];
    const lines = fs.readFileSync(eventsFile, 'utf-8').split('\n').filter(Boolean);

    for (const line of lines) {
      try {
        const event = JSON.parse(line) as TaskEvent;
        results.push(event);
      } catch { /* skip malformed */ }
    }

    return results.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  private emitEvent(taskId: string, kind: string, payload: Record<string, unknown>): void {
    const event: TaskEvent = {
      id: uuid(),
      taskId,
      kind,
      payload,
      timestamp: now(),
    };
    appendJsonLine(this.eventsPath(taskId), event);
  }

  private normalizePortRequests(ports?: number | number[] | PortSpec[]): PortRequest[] {
    if (ports === undefined || ports === null) {
      return [{ name: 'http' }];
    }
    if (typeof ports === 'number') return [{ name: 'http', port: ports }];
    if (Array.isArray(ports)) {
      if (ports.length === 0) return [{ name: 'http' }];
      return ports.map((p, i) => {
        if (typeof p === 'number') return { name: i === 0 ? 'http' : `port-${i}`, port: p };
        return { name: p.name, port: p.port, protocol: p.protocol };
      });
    }
    return [{ name: 'http' }];
  }
}

export class OrchestratorError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'OrchestratorError';
  }
}
