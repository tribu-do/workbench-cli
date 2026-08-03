/**
 * src/sessions/store.ts — File-first session journal store.
 *
 * A "session" IS a task-shaped journal record — there is no separate session.yaml. Every session
 * field, including the selected runtime mode, lives in this record's YAML frontmatter at
 * `.workbench/memory/.this/journals/<YYYY_MM_DD>/<session-id>/journal.md`.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { globSync } from 'glob';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { resolveJournalsDir, resolveMemoryThisDir } from '../config.js';

export type SessionState = 'draft' | 'running';

/**
 * Canonical definition of a persisted secret selection. Single-sourced here (the store owns the
 * session record shape); the create wizard `import type`s this rather than redeclaring it.
 */
export interface SecretSelection {
  key: string;
  scope: 'global';
  source: 'configured' | 'prompted';
}

export interface SessionRecord {
  session_id: string;
  state: SessionState;
  created_at: string;
  updated_at: string;
  req_sources: string[];
  agent: string;
  user_preferences: string[];
  agent_preferences: string[];
  task_components: string[];
  worktree: { branch: string; path?: string };
  runtime: { profile: string; mode: string };
  port: number;
  preview: { enabled: boolean; target?: string };
  secrets: SecretSelection[];
  prompt_path: string;
  runtime_state?: { pid?: number; started_at?: string };
}

const JOURNAL_FILENAME = 'journal.md';
const PROMPT_FILENAME = 'prompt.md';

/** YYYY_MM_DD bucket, matching the `.this` journals layout. */
function dateBucket(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}_${m}_${day}`;
}

/**
 * Directory for a session's journal record: `journals/<YYYY_MM_DD>/<session-id>/` under the
 * journals root single-sourced by architecture's `resolveJournalsDir()` (D-1 canonical store).
 */
function journalDir(bucket: string, sessionId: string): string {
  return path.join(resolveJournalsDir(), bucket, sessionId);
}

function journalPath(dir: string): string {
  return path.join(dir, JOURNAL_FILENAME);
}

function promptPath(dir: string): string {
  return path.join(dir, PROMPT_FILENAME);
}

/** Allocate a session id. Call this first — before any runtime setup starts. */
export function allocateSessionId(): string {
  return crypto.randomUUID();
}

/**
 * Build the session prompt body from selected REQ files and selected internal task components.
 * Pure concatenation of source markdown — carries no runtime, agent, or port information, so the
 * REQ files stay ignorant of how the session is executed.
 */
export function buildPromptBody(input: {
  repoRoot: string;
  reqSources: string[];
  taskComponents: string[];
}): string {
  const sections: string[] = [];
  for (const rel of input.reqSources) {
    sections.push(`## REQ: ${rel}\n\n${fs.readFileSync(path.join(input.repoRoot, rel), 'utf-8')}`);
  }
  for (const rel of input.taskComponents) {
    sections.push(`## Component: ${rel}\n\n${fs.readFileSync(path.join(resolveMemoryThisDir(), rel), 'utf-8')}`);
  }
  return sections.join('\n\n---\n\n');
}

export interface CreateDraftSessionInput {
  sessionId: string;
  reqSources: string[];
  agent: string;
  userPreferences: string[];
  agentPreferences: string[];
  taskComponents: string[];
  worktreeBranch: string;
  runtimeProfile: string;
  runtimeMode: string;
  port: number;
  previewEnabled: boolean;
  previewTarget?: string;
  secrets: SecretSelection[];
  promptBody: string;
}

/**
 * Persist the draft session record: creates the journal directory, writes `prompt.md`, then
 * writes `journal.md` with `state: 'draft'`. The session id must already be allocated.
 */
export function createDraftSession(input: CreateDraftSessionInput): { dir: string; record: SessionRecord } {
  const bucket = dateBucket();
  const dir = journalDir(bucket, input.sessionId);
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(promptPath(dir), input.promptBody, 'utf-8');

  const now = new Date().toISOString();
  const record: SessionRecord = {
    session_id: input.sessionId,
    state: 'draft',
    created_at: now,
    updated_at: now,
    req_sources: input.reqSources,
    agent: input.agent,
    user_preferences: input.userPreferences,
    agent_preferences: input.agentPreferences,
    task_components: input.taskComponents,
    worktree: { branch: input.worktreeBranch },
    runtime: { profile: input.runtimeProfile, mode: input.runtimeMode },
    port: input.port,
    preview: { enabled: input.previewEnabled, target: input.previewTarget },
    secrets: input.secrets,
    prompt_path: path.relative(resolveMemoryThisDir(), promptPath(dir)),
  };

  writeJournal(dir, record);
  return { dir, record };
}

/** Serialize the record as YAML frontmatter and write `journal.md`. */
export function writeJournal(dir: string, record: SessionRecord): void {
  const frontmatter = stringifyYaml(record).trimEnd();
  const body = [
    `# Session ${record.session_id}`,
    '',
    'Managed by `workbench session`. Do not hand-edit the fields above; use',
    '`workbench session start` / `workbench session status`.',
    '',
  ].join('\n');
  fs.writeFileSync(journalPath(dir), `---\n${frontmatter}\n---\n\n${body}`, 'utf-8');
}

/** Locate and read a session record by id, scanning the date-bucketed journals tree. */
export function findSession(sessionId: string): { dir: string; record: SessionRecord } | null {
  const root = resolveJournalsDir();
  const matches = globSync(path.join(root, '*', sessionId, JOURNAL_FILENAME));
  if (matches.length === 0) return null;

  const file = matches[0];
  const dir = path.dirname(file);
  const raw = fs.readFileSync(file, 'utf-8');
  const fm = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) throw new Error(`Malformed journal record at ${file}`);

  const record = parseYaml(fm[1]) as SessionRecord;
  return { dir, record };
}

export function readPrompt(dir: string): string {
  return fs.readFileSync(promptPath(dir), 'utf-8');
}
