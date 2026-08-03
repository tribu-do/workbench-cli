/**
 * AgentProvider port — Common contract for Claude / Codex / Copilot.
 */

export interface AgentLaunchSpec {
  taskId: string;
  worktreePath: string;
  containerId?: string;
  prompt?: string;
  autoApprove: boolean;
  envVars?: Record<string, string>;
  /** Skill IDs to expose to the agent. */
  skills?: string[];
}

export interface AgentSession {
  taskId: string;
  provider: 'claude' | 'codex' | 'copilot';
  pid?: number;
  containerId?: string;
  startedAt: string;
}

export interface AgentProvider {
  name: 'claude' | 'codex' | 'copilot';

  /** Whether the agent CLI is installed and reachable. */
  isAvailable(): boolean;

  /**
   * Launch the agent. May run inside a container (when containerId given) or on the host.
   * Returns an AgentSession reference; the actual process runs detached or via the container.
   */
  launch(spec: AgentLaunchSpec): Promise<AgentSession>;
}
