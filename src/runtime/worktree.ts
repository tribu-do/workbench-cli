/**
 * Git worktree management — Tasks get an isolated worktree on a branch.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

export class WorktreeError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'WorktreeError';
  }
}

/**
 * Create a git worktree for a task.
 * - If the repo has no commits, throws GIT_NOT_INITIALIZED.
 * - If branch exists, the worktree is checked out to it.
 * - If branch doesn't exist, it's created from HEAD.
 */
export function createWorktree(opts: {
  repoRoot: string;
  taskId: string;
  branch: string;
}): string {
  if (!isGitRepo(opts.repoRoot)) {
    throw new WorktreeError(
      'GIT_NOT_INITIALIZED',
      `${opts.repoRoot} is not a git repository. Run \`git init\` first.`,
    );
  }

  const worktreePath = path.join(opts.repoRoot, '.workbench', 'worktrees', opts.taskId);
  const parent = path.dirname(worktreePath);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });

  // Check if branch exists
  const branchExists = safeGit(opts.repoRoot, ['rev-parse', '--verify', opts.branch]) !== null;

  try {
    if (branchExists) {
      git(opts.repoRoot, ['worktree', 'add', worktreePath, opts.branch]);
    } else {
      git(opts.repoRoot, ['worktree', 'add', '-b', opts.branch, worktreePath]);
    }
  } catch (err) {
    throw new WorktreeError(
      'WORKTREE_ADD_FAILED',
      `git worktree add failed: ${err instanceof Error ? err.message : err}`,
    );
  }

  return worktreePath;
}

/**
 * Remove a worktree (called on task merge/abort).
 * Force removes; the branch is preserved.
 */
export function removeWorktree(opts: { repoRoot: string; worktreePath: string }): void {
  if (!fs.existsSync(opts.worktreePath)) return;
  try {
    git(opts.repoRoot, ['worktree', 'remove', '--force', opts.worktreePath]);
  } catch {
    // Fallback: prune + manual rm
    try { git(opts.repoRoot, ['worktree', 'prune']); } catch { /* ignore */ }
    fs.rmSync(opts.worktreePath, { recursive: true, force: true });
  }
}

export function findRepoRoot(startDir?: string): string | null {
  let dir = startDir ?? process.cwd();
  while (true) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function isGitRepo(dir: string): boolean {
  if (!fs.existsSync(path.join(dir, '.git'))) return false;
  // Verify there's at least one commit (worktree add requires HEAD)
  return safeGit(dir, ['rev-parse', '--verify', 'HEAD']) !== null;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

function safeGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}
