/**
 * src/runtime/launch.ts — Runtime setup + agent execution for `workbench session start`.
 *
 * Implements the `bare-host` runtime mode only (host worktree + direct process). Other runtime
 * modes are owned by the `runtime` domain's own launch orchestration once specified.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createWorktree, findRepoRoot } from './worktree.js';
import { ClaudeProvider } from '../agents/claude.js';
import { resolveWorkbenchDir } from '../config.js';
import type { SessionRecord } from '../sessions/store.js';

export const TRANSPARENT_WRAPPER_INSTRUCTION = [
  'You are running inside a Workbench-managed session.',
  'Work only inside this session\'s worktree.',
  'Treat the content above this instruction as the full scope of the session — do not expand it.',
  'Stop and report for review once the acceptance criteria in the scaffolded prompt are met.',
].join(' ');

export class RuntimeLaunchError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'RuntimeLaunchError';
  }
}

/** Required secret keys per agent, resolved from process.env (populated by `loadCredentials()`). */
export const AGENT_REQUIRED_SECRETS: Record<string, string[]> = {
  claude: ['ANTHROPIC_API_KEY'],
  codex: ['OPENAI_API_KEY'],
  copilot: ['GITHUB_TOKEN'],
};

export function requiredSecretsFor(agent: string): string[] {
  return AGENT_REQUIRED_SECRETS[agent] ?? [];
}

/** Append a reserved-lease event for the session's port to `.workbench/leases.jsonl`. */
export function reservePortForSession(sessionId: string, port: number, name = 'primary'): void {
  const leasesFile = path.join(resolveWorkbenchDir(), 'leases.jsonl');
  fs.mkdirSync(path.dirname(leasesFile), { recursive: true });
  fs.appendFileSync(
    leasesFile,
    JSON.stringify({
      sessionId,
      name,
      port,
      state: 'reserved',
      reservedAt: new Date().toISOString(),
    }) + '\n',
  );
}

export interface LaunchResult {
  sessionId: string;
  runtimeState: 'running';
  pid?: number;
  worktreePath: string;
  startedAt: string;
}

/**
 * Perform runtime setup and agent execution for the session's persisted runtime choice.
 * `secretValues` must already be resolved (env var name -> value) by the caller.
 */
export async function launchSessionRuntime(
  record: SessionRecord,
  promptBody: string,
  secretValues: Record<string, string>,
): Promise<LaunchResult> {
  if (record.runtime.mode !== 'bare-host') {
    throw new RuntimeLaunchError(
      'RUNTIME_MODE_NOT_IMPLEMENTED',
      `Runtime mode "${record.runtime.mode}" (profile "${record.runtime.profile}") has no launch ` +
        'orchestration yet. Only "bare-host" is implemented here; other modes land with their own ' +
        'runtime-domain REQ.',
    );
  }

  if (record.agent !== 'claude') {
    throw new RuntimeLaunchError(
      'AGENT_NOT_IMPLEMENTED',
      `Agent provider "${record.agent}" has no launch implementation yet; only "claude" is wired.`,
    );
  }

  const repoRoot = findRepoRoot() ?? process.cwd();
  const worktreePath = createWorktree({
    repoRoot,
    taskId: record.session_id,
    branch: record.worktree.branch,
  });

  reservePortForSession(record.session_id, record.port);

  const fullPrompt = `${promptBody}\n\n---\n\n${TRANSPARENT_WRAPPER_INSTRUCTION}\n`;

  const provider = new ClaudeProvider();
  const agentSession = await provider.launch({
    taskId: record.session_id,
    worktreePath,
    prompt: fullPrompt,
    autoApprove: false,
    envVars: secretValues,
  });

  return {
    sessionId: record.session_id,
    runtimeState: 'running',
    pid: agentSession.pid,
    worktreePath,
    startedAt: agentSession.startedAt,
  };
}
