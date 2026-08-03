/**
 * MemoryService — Hierarchical memory with scope cascade.
 * Implements LLD-2 memory operations.
 * File-first: records stored as YAML files in `.workbench/memory/.this/records/`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type {
  Scope,
  ScopeContext,
  MemoryRecord,
} from '../types.js';
import { resolveMemoryThisDir } from '../config.js';
import { now, uuid } from '../stores/file-utils.js';

interface StoredRecord {
  id: string;
  scope: Scope;
  scopeId: string;
  namespace: string;
  key: string;
  body: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

const SCOPES: Scope[] = ['global', 'workspace', 'session', 'task'];

export class MemoryService {
  constructor() {}

  private resolveRecordsDir(): string {
    return path.join(resolveMemoryThisDir(), 'records');
  }

  private recordPath(scope: Scope, scopeId: string, namespace: string, key: string): string {
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.resolveRecordsDir(), scope, scopeId, namespace, `${safeKey}.yaml`);
  }

  private readRecordFile(filePath: string): StoredRecord | null {
    if (!fs.existsSync(filePath)) return null;
    try {
      return parseYaml(fs.readFileSync(filePath, 'utf-8')) as StoredRecord;
    } catch {
      return null;
    }
  }

  private storedToRecord(stored: StoredRecord): MemoryRecord {
    return {
      id: stored.id,
      scope: stored.scope,
      scopeId: stored.scopeId,
      namespace: stored.namespace,
      key: stored.key,
      body: stored.body,
      metadata: stored.metadata,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
    };
  }

  private findRecordById(id: string): { path: string; record: StoredRecord } | null {
    const recordsDir = this.resolveRecordsDir();
    if (!fs.existsSync(recordsDir)) return null;

    for (const scope of SCOPES) {
      const scopeDir = path.join(recordsDir, scope);
      if (!fs.existsSync(scopeDir)) continue;

      for (const scopeId of fs.readdirSync(scopeDir)) {
        const sidDir = path.join(scopeDir, scopeId);
        if (!fs.statSync(sidDir).isDirectory()) continue;

        for (const ns of fs.readdirSync(sidDir)) {
          const nsDir = path.join(sidDir, ns);
          if (!fs.statSync(nsDir).isDirectory()) continue;

          for (const file of fs.readdirSync(nsDir)) {
            if (!file.endsWith('.yaml')) continue;
            const filePath = path.join(nsDir, file);
            const stored = this.readRecordFile(filePath);
            if (stored?.id === id) {
              return { path: filePath, record: stored };
            }
          }
        }
      }
    }

    return null;
  }

  put(scope: Scope, scopeId: string, namespace: string, key: string, body: string, metadata?: Record<string, unknown>): MemoryRecord {
    const timestamp = now();
    const filePath = this.recordPath(scope, scopeId, namespace, key);
    const existing = this.readRecordFile(filePath);

    const stored: StoredRecord = {
      id: existing?.id ?? uuid(),
      scope,
      scopeId,
      namespace,
      key,
      body,
      metadata: metadata ?? {},
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, stringifyYaml(stored, { indent: 2 }), 'utf-8');

    return this.storedToRecord(stored);
  }

  get(namespace: string, key: string, ctx: ScopeContext): MemoryRecord | null {
    const scopes: [Scope, string][] = [];
    if (ctx.taskId) scopes.push(['task', ctx.taskId]);
    if (ctx.sessionId) scopes.push(['session', ctx.sessionId]);
    if (ctx.workspaceId) scopes.push(['workspace', ctx.workspaceId]);
    scopes.push(['global', 'global']);

    for (const [scope, scopeId] of scopes) {
      const filePath = this.recordPath(scope, scopeId, namespace, key);
      const stored = this.readRecordFile(filePath);
      if (stored) return this.storedToRecord(stored);
    }

    return null;
  }

  list(scope: Scope, scopeId: string, namespace?: string): MemoryRecord[] {
    const results: MemoryRecord[] = [];
    const baseDir = path.join(this.resolveRecordsDir(), scope, scopeId);

    if (!fs.existsSync(baseDir)) return results;

    const namespacesToScan: string[] = [];
    if (namespace) {
      namespacesToScan.push(namespace);
    } else {
      for (const ns of fs.readdirSync(baseDir)) {
        const nsPath = path.join(baseDir, ns);
        if (fs.statSync(nsPath).isDirectory()) {
          namespacesToScan.push(ns);
        }
      }
    }

    for (const ns of namespacesToScan) {
      const nsDir = path.join(baseDir, ns);
      if (!fs.existsSync(nsDir)) continue;

      for (const file of fs.readdirSync(nsDir)) {
        if (!file.endsWith('.yaml')) continue;
        const stored = this.readRecordFile(path.join(nsDir, file));
        if (stored) results.push(this.storedToRecord(stored));
      }
    }

    return results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  search(query: string, scope?: Scope, scopeId?: string): MemoryRecord[] {
    const results: MemoryRecord[] = [];
    const recordsDir = this.resolveRecordsDir();

    if (!fs.existsSync(recordsDir)) return results;

    const lowerQuery = query.toLowerCase();

    const scopesToScan: [Scope, string][] = [];
    if (scope && scopeId) {
      scopesToScan.push([scope, scopeId]);
    } else {
      for (const s of SCOPES) {
        const scopeDir = path.join(recordsDir, s);
        if (fs.existsSync(scopeDir)) {
          for (const sid of fs.readdirSync(scopeDir)) {
            if (fs.statSync(path.join(scopeDir, sid)).isDirectory()) {
              scopesToScan.push([s, sid]);
            }
          }
        }
      }
    }

    for (const [s, sid] of scopesToScan) {
      const baseDir = path.join(recordsDir, s, sid);
      if (!fs.existsSync(baseDir)) continue;

      for (const ns of fs.readdirSync(baseDir)) {
        const nsDir = path.join(baseDir, ns);
        if (!fs.statSync(nsDir).isDirectory()) continue;

        for (const file of fs.readdirSync(nsDir)) {
          if (!file.endsWith('.yaml')) continue;
          const stored = this.readRecordFile(path.join(nsDir, file));
          if (stored && stored.body.toLowerCase().includes(lowerQuery)) {
            results.push(this.storedToRecord(stored));
          }
        }
      }
    }

    return results
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 50);
  }

  delete(id: string): boolean {
    const found = this.findRecordById(id);
    if (!found) return false;
    fs.rmSync(found.path, { force: true });
    return true;
  }

  promote(id: string, toScope: Scope, toScopeId: string): MemoryRecord {
    const found = this.findRecordById(id);
    if (!found) throw new Error(`Memory record ${id} not found`);

    const record = found.record;
    return this.put(
      toScope,
      toScopeId,
      record.namespace,
      record.key,
      record.body,
      { ...record.metadata, provenance: { from: record.scope, fromId: record.scopeId, promotedAt: now() } },
    );
  }

  private getById(id: string): MemoryRecord | null {
    const found = this.findRecordById(id);
    return found ? this.storedToRecord(found.record) : null;
  }
}
