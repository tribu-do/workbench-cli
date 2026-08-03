/**
 * SessionService — Session lifecycle management.
 * Sessions are first-class working units; many tasks belong to one session.
 * File-first: sessions stored as YAML files in `.workbench/sessions/`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { Session, SessionState, RuntimeMode } from '../types.js';
import { resolveWorkbenchDir } from '../config.js';

const CURRENT_SESSION_FILE = '.workbench/current-session';

interface StoredSession {
  id: string;
  workspaceId: string;
  name: string;
  state: SessionState;
  runtimeMode: RuntimeMode;
  agent: 'claude' | 'codex' | 'copilot';
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
}

export class SessionService {
  constructor() {}

  private resolveSessionsDir(): string {
    return path.join(resolveWorkbenchDir(), 'sessions');
  }

  private sessionPath(id: string): string {
    return path.join(this.resolveSessionsDir(), `${id}.yaml`);
  }

  private now(): string {
    return new Date().toISOString();
  }

  private uuid(): string {
    return randomUUID();
  }

  private readSessionFile(filePath: string): StoredSession | null {
    if (!fs.existsSync(filePath)) return null;
    try {
      return parseYaml(fs.readFileSync(filePath, 'utf-8')) as StoredSession;
    } catch {
      return null;
    }
  }

  private storedToSession(stored: StoredSession): Session {
    return {
      id: stored.id,
      workspaceId: stored.workspaceId,
      name: stored.name,
      state: stored.state,
      runtimeMode: stored.runtimeMode,
      agent: stored.agent,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      endedAt: stored.endedAt,
    };
  }

  private writeSession(stored: StoredSession): void {
    const filePath = this.sessionPath(stored.id);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, stringifyYaml(stored, { indent: 2 }), 'utf-8');
  }

  create(spec: {
    workspaceId: string;
    name?: string;
    runtimeMode: RuntimeMode;
    agent?: 'claude' | 'codex' | 'copilot';
  }): Session {
    const id = this.uuid();
    const now = this.now();
    const name = spec.name ?? `session-${id.slice(0, 8)}`;
    const agent = spec.agent ?? 'claude';

    const stored: StoredSession = {
      id,
      workspaceId: spec.workspaceId,
      name,
      state: 'active',
      runtimeMode: spec.runtimeMode,
      agent,
      createdAt: now,
      updatedAt: now,
    };

    this.writeSession(stored);

    return this.storedToSession(stored);
  }

  get(id: string): Session | null {
    const stored = this.readSessionFile(this.sessionPath(id));
    return stored ? this.storedToSession(stored) : null;
  }

  list(filter?: { workspaceId?: string; state?: SessionState }): Session[] {
    const sessionsDir = this.resolveSessionsDir();
    if (!fs.existsSync(sessionsDir)) return [];

    const results: Session[] = [];

    for (const file of fs.readdirSync(sessionsDir)) {
      if (!file.endsWith('.yaml')) continue;
      const stored = this.readSessionFile(path.join(sessionsDir, file));
      if (!stored) continue;

      if (filter?.workspaceId && stored.workspaceId !== filter.workspaceId) continue;
      if (filter?.state && stored.state !== filter.state) continue;

      results.push(this.storedToSession(stored));
    }

    return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  transition(id: string, newState: SessionState): Session {
    const stored = this.readSessionFile(this.sessionPath(id));
    if (!stored) throw new Error(`Session ${id} not found`);
    if (stored.state === 'ended') throw new Error(`Session ${id} already ended`);

    const now = this.now();
    stored.state = newState;
    stored.updatedAt = now;
    if (newState === 'ended') stored.endedAt = now;

    this.writeSession(stored);

    return this.storedToSession(stored);
  }

  stop(id: string): { session: Session; tasksAborted: number } {
    const session = this.transition(id, 'ended');

    // Note: task abortion is handled by Orchestrator (which has task access)
    // This service just transitions the session state.
    // The caller is responsible for aborting tasks if needed.
    return { session, tasksAborted: 0 };
  }

  attach(id: string): void {
    const session = this.get(id);
    if (!session) throw new Error(`Session ${id} not found`);
    if (session.state === 'ended') throw new Error(`Session ${id} is ended`);

    const filepath = path.join(process.cwd(), CURRENT_SESSION_FILE);
    fs.writeFileSync(filepath, id, 'utf-8');
  }

  current(): Session | null {
    const filepath = path.join(process.cwd(), CURRENT_SESSION_FILE);
    if (!fs.existsSync(filepath)) return null;

    const id = fs.readFileSync(filepath, 'utf-8').trim();
    if (!id) return null;

    const session = this.get(id);
    if (!session || session.state === 'ended') return null;
    return session;
  }

  getOrCreateCurrent(workspaceId: string, runtimeMode: RuntimeMode): Session {
    const current = this.current();
    if (current) return current;

    const session = this.create({ workspaceId, runtimeMode, name: 'default' });
    this.attach(session.id);
    return session;
  }
}
