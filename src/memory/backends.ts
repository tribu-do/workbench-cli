/**
 * Memory backend abstraction — Pluggable memory/context stores.
 * File-first: SQLite backend removed.
 *
 * Backends:
 *   - openviking: OpenViking contextual memory with self-iteration loop
 *   - lancedb: LanceDB vector store for semantic search
 *   - file: File-based memory (default, uses MemoryService)
 */

import { execFileSync, spawn } from 'node:child_process';
import type { Scope } from '../types.js';
import { resolveOpenVikingWorkspace } from '../config.js';
import { MemoryService } from './service.js';

export type MemoryBackendType = 'openviking' | 'lancedb' | 'file';

export interface MemoryEntry {
  id: string;
  namespace: string;
  key: string;
  content: string;
  metadata?: Record<string, unknown>;
  embedding?: number[];
  createdAt: string;
  updatedAt: string;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
}

export interface ExtractionResult {
  userMemories: MemoryEntry[];
  agentExperiences: MemoryEntry[];
  sessionContext: MemoryEntry[];
}

export interface MemoryBackend {
  readonly type: MemoryBackendType;

  isAvailable(): Promise<boolean>;
  put(scope: Scope, scopeId: string, entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryEntry>;
  get(scope: Scope, scopeId: string, namespace: string, key: string): Promise<MemoryEntry | null>;
  search(query: string, scope?: Scope, scopeId?: string, limit?: number): Promise<MemorySearchResult[]>;
  delete(id: string): Promise<boolean>;
  extractFromSession(sessionId: string, taskResults: string, feedback?: string): Promise<ExtractionResult>;
  sync?(): Promise<void>;
}

/**
 * File-based memory backend (default)
 */
export class FileMemoryBackend implements MemoryBackend {
  readonly type: MemoryBackendType = 'file';
  private service: MemoryService;

  constructor() {
    this.service = new MemoryService();
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async put(
    scope: Scope,
    scopeId: string,
    entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<MemoryEntry> {
    const record = this.service.put(scope, scopeId, entry.namespace, entry.key, entry.content, entry.metadata);
    return {
      id: record.id,
      namespace: record.namespace,
      key: record.key,
      content: record.body,
      metadata: record.metadata,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  async get(scope: Scope, scopeId: string, namespace: string, key: string): Promise<MemoryEntry | null> {
    const record = this.service.get(namespace, key, {
      workspaceId: scope === 'workspace' ? scopeId : undefined,
      sessionId: scope === 'session' ? scopeId : undefined,
      taskId: scope === 'task' ? scopeId : undefined,
    });
    if (!record) return null;

    return {
      id: record.id,
      namespace: record.namespace,
      key: record.key,
      content: record.body,
      metadata: record.metadata,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  async search(query: string, scope?: Scope, scopeId?: string, limit = 50): Promise<MemorySearchResult[]> {
    const records = this.service.search(query, scope, scopeId).slice(0, limit);
    return records.map((r) => ({
      entry: {
        id: r.id,
        namespace: r.namespace,
        key: r.key,
        content: r.body,
        metadata: r.metadata,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      },
      score: 1.0,
    }));
  }

  async delete(id: string): Promise<boolean> {
    return this.service.delete(id);
  }

  async extractFromSession(sessionId: string, taskResults: string, feedback?: string): Promise<ExtractionResult> {
    const now = new Date().toISOString();
    const summaryKey = `session-${sessionId}-summary`;

    await this.put('session', sessionId, {
      namespace: 'context',
      key: summaryKey,
      content: taskResults,
      metadata: { feedback, extractedAt: now },
    });

    return {
      userMemories: [],
      agentExperiences: [],
      sessionContext: [{
        id: summaryKey,
        namespace: 'context',
        key: summaryKey,
        content: taskResults,
        metadata: { feedback },
        createdAt: now,
        updatedAt: now,
      }],
    };
  }
}

/**
 * OpenViking memory backend
 */
export class OpenVikingBackend implements MemoryBackend {
  readonly type: MemoryBackendType = 'openviking';

  private readonly serverUrl: string;
  private readonly workspace: string;
  private readonly apiKey: string | undefined;

  constructor(opts?: { serverUrl?: string; workspace?: string }) {
    this.serverUrl = opts?.serverUrl
      ?? process.env.WORKBENCH_OPENVIKING_URL
      ?? 'http://localhost:1933';
    this.workspace = opts?.workspace
      ?? resolveOpenVikingWorkspace();
    this.apiKey = process.env.WORKBENCH_OPENVIKING_API_KEY;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.serverUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return true;
    } catch { /* server not running */ }

    return this.isPythonSdkAvailable();
  }

  async addResource(path: string, targetUri: string, opts?: {
    summarize?: boolean;
    buildIndex?: boolean;
  }): Promise<void> {
    if (await this.isServerReachable()) {
      await this.httpPost('/v1/resources', {
        path,
        to: targetUri,
        build_index: opts?.buildIndex ?? true,
        summarize: opts?.summarize ?? false,
      });
      return;
    }
    await this.pyRun(`
from openviking import SyncOpenViking
client = SyncOpenViking(path="${this.workspace}")
client.initialize()
client.add_resource(${JSON.stringify(path)}, to=${JSON.stringify(targetUri)},
                    build_index=${opts?.buildIndex !== false}, summarize=${opts?.summarize ? 'True' : 'False'},
                    wait=True)
print("ok")
`);
  }

  async put(
    _scope: Scope,
    _scopeId: string,
    entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<MemoryEntry> {
    const uri = `viking://user/memories/${entry.namespace}/${entry.key}`;
    const now = new Date().toISOString();

    if (await this.isServerReachable()) {
      await this.httpPost('/v1/write', {
        uri,
        content: entry.content,
        mode: 'replace',
      });
    } else {
      await this.pyRun(`
from openviking import SyncOpenViking
client = SyncOpenViking(path="${this.workspace}")
client.initialize()
client.write(${JSON.stringify(uri)}, ${JSON.stringify(entry.content)}, mode="replace", wait=True)
print("ok")
`);
    }

    return {
      id: uri,
      namespace: entry.namespace,
      key: entry.key,
      content: entry.content,
      metadata: entry.metadata,
      createdAt: now,
      updatedAt: now,
    };
  }

  async get(_scope: Scope, _scopeId: string, namespace: string, key: string): Promise<MemoryEntry | null> {
    const uri = `viking://user/memories/${namespace}/${key}`;

    try {
      let content: string;
      if (await this.isServerReachable()) {
        const res = await this.httpGet(`/v1/read?uri=${encodeURIComponent(uri)}`);
        content = (res as { content: string }).content;
      } else {
        content = await this.pyRun(`
from openviking import SyncOpenViking
client = SyncOpenViking(path="${this.workspace}")
client.initialize()
print(client.read(${JSON.stringify(uri)}))
`);
      }
      const now = new Date().toISOString();
      return { id: uri, namespace, key, content, createdAt: now, updatedAt: now };
    } catch {
      return null;
    }
  }

  async search(query: string, _scope?: Scope, _scopeId?: string, limit = 10): Promise<MemorySearchResult[]> {
    if (await this.isServerReachable()) {
      const res = await this.httpPost('/v1/find', { query, limit }) as OvFindResponse;
      return (res.results ?? []).map(ovResultToEntry);
    }

    const raw = await this.pyRun(`
import json
from openviking import SyncOpenViking
client = SyncOpenViking(path="${this.workspace}")
client.initialize()
results = client.find(${JSON.stringify(query)}, limit=${limit})
print(json.dumps(results if isinstance(results, list) else []))
`);
    try {
      const parsed = JSON.parse(raw) as OvResult[];
      return parsed.map(ovResultToEntry);
    } catch {
      return [];
    }
  }

  async delete(id: string): Promise<boolean> {
    const uri = id.startsWith('viking://') ? id : `viking://user/memories/${id}`;
    try {
      if (await this.isServerReachable()) {
        await this.httpPost('/v1/rm', { uri });
      } else {
        await this.pyRun(`
from openviking import SyncOpenViking
client = SyncOpenViking(path="${this.workspace}")
client.initialize()
client.rm(${JSON.stringify(uri)})
print("ok")
`);
      }
      return true;
    } catch {
      return false;
    }
  }

  async extractFromSession(sessionId: string, taskResults: string, feedback?: string): Promise<ExtractionResult> {
    const summary = feedback ? `${taskResults}\n\nFeedback: ${feedback}` : taskResults;
    const now = new Date().toISOString();

    try {
      if (await this.isServerReachable()) {
        await this.httpPost('/v1/sessions/message', {
          session_id: sessionId,
          role: 'assistant',
          content: summary,
        });
        await this.httpPost('/v1/sessions/commit', { session_id: sessionId });
      } else {
        await this.pyRun(`
from openviking import SyncOpenViking
client = SyncOpenViking(path="${this.workspace}")
client.initialize()
client.add_message(${JSON.stringify(sessionId)}, "assistant", ${JSON.stringify(summary)})
client.commit_session(${JSON.stringify(sessionId)})
print("ok")
`);
      }
    } catch (err) {
      console.warn('OpenViking session commit failed:', err);
    }

    return {
      userMemories: [{
        id: `${sessionId}-summary`,
        namespace: 'sessions',
        key: sessionId,
        content: summary,
        metadata: { extractedAt: now, via: 'commit_session' },
        createdAt: now,
        updatedAt: now,
      }],
      agentExperiences: [],
      sessionContext: [],
    };
  }

  async sync(): Promise<void> {
    if (await this.isServerReachable()) {
      await this.httpPost('/v1/sync', {});
    }
  }

  private async isServerReachable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.serverUrl}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async httpGet(path: string): Promise<unknown> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
    const res = await fetch(`${this.serverUrl}${path}`, { headers });
    if (!res.ok) throw new Error(`OpenViking HTTP GET ${path} → ${res.status}`);
    return res.json();
  }

  private async httpPost(path: string, body: unknown): Promise<unknown> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
    const res = await fetch(`${this.serverUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`OpenViking HTTP POST ${path} → ${res.status}`);
    return res.json();
  }

  private isPythonSdkAvailable(): boolean {
    try {
      execFileSync('python3', ['-c', 'import openviking'], { stdio: 'ignore', timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  private async pyRun(script: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('python3', ['-c', script], { env: process.env });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      proc.on('close', (code) => {
        if (code !== 0) reject(new Error(`openviking py: ${stderr.trim()}`));
        else resolve(stdout.trim());
      });
    });
  }
}

/**
 * Get the configured memory backend
 */
export function getMemoryBackend(type?: MemoryBackendType): MemoryBackend {
  const backendType = type ?? (process.env.WORKBENCH_MEMORY_BACKEND as MemoryBackendType) ?? 'file';

  switch (backendType) {
    case 'openviking':
      return new OpenVikingBackend();
    case 'lancedb':
      console.warn('LanceDB backend not yet implemented; using file backend');
      return new FileMemoryBackend();
    case 'file':
    default:
      return new FileMemoryBackend();
  }
}

interface OvResult {
  uri?: string;
  content?: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

interface OvFindResponse {
  results?: OvResult[];
}

function ovResultToEntry(r: OvResult): MemorySearchResult {
  const uri = r.uri ?? '';
  const parts = uri.replace('viking://', '').split('/');
  const now = new Date().toISOString();
  return {
    entry: {
      id: uri,
      namespace: parts.slice(0, -1).join('/') || 'default',
      key: parts[parts.length - 1] ?? uri,
      content: r.content ?? '',
      metadata: r.metadata,
      createdAt: now,
      updatedAt: now,
    },
    score: r.score ?? 1.0,
  };
}
