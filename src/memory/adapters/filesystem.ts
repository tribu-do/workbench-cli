/**
 * Built-in `.this` memory plugin — the default, source-of-truth adapter. Records are Markdown with
 * YAML frontmatter under `.workbench/memory/.this/`; search degrades to grep when no vector index
 * is present. No SQLite.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveMemoryThisDir } from '../../config.js';
import type {
  MemoryPlugin, PluginCapabilities, ScopeRef, RecordInput, RecordMeta,
  RecordUri, SearchQuery, RankedRecord, ExtractionResult, PromotionDiff,
  PromoteOpts, ExportPack, ImportReport, CapabilityReport, MemoryDiff, MemoryStats, Scope,
} from '../interface.js';

/** Date stamp for the dated journal layout: `YYYY_MM_DD` (matches the durable-tree diagram). */
function journalDate(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '_');
}

/**
 * Maps a scope to a subtree inside `.this`. user/agents/project live in the repo.
 * task/session resolve to the canonical dated journal form
 * `journals/<YYYY_MM_DD>/<task-id>/scratch` (frozen store of record).
 */
const SCOPE_DIR: Record<Scope, (id: string) => string> = {
  org:     () => 'resources/org',
  user:    () => 'user',
  agent:   (id) => `agents/${id}`,
  project: () => 'user',            // project-local user knowledge tree
  task:    (id) => `journals/${journalDate()}/${id}/scratch`,
  session: (id) => `journals/${journalDate()}/${id}/scratch`,
};

export class FilesystemPlugin implements MemoryPlugin {
  readonly name = 'filesystem';
  readonly capabilities: PluginCapabilities = {
    scopes: ['org', 'user', 'agent', 'project', 'task', 'session'],
    features: ['export'],                    // no vector/rerank — search is path + grep
  };

  private root = resolveMemoryThisDir();

  async put(scope: ScopeRef, record: RecordInput, meta: RecordMeta): Promise<RecordUri> {
    if (record.grounding.length === 0) throw new Error('Record rejected: grounding required');
    const slug = record.body.toLowerCase().slice(0, 50).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const rel = path.join(SCOPE_DIR[scope.scope](scope.id), `${record.kind}s`, `${slug}.md`);
    const abs = path.join(this.root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, this.toMarkdown(record, meta));
    return `memory://${scope.scope}/${record.kind}/${slug}`;
  }

  /** Path + grep search — the floor every plugin degrades to. */
  async search(query: SearchQuery): Promise<RankedRecord[]> {
    const dir = path.join(this.root, SCOPE_DIR[query.scope.scope](query.scope.id));
    if (!fs.existsSync(dir)) return [];
    let hits: string[] = [];
    try {
      const out = execFileSync('grep', ['-rli', query.query, dir], { encoding: 'utf8' });
      hits = out.split('\n').filter(Boolean);
    } catch { /* grep exit 1 = no matches */ }
    return hits.slice(0, Math.ceil(query.budget / 50)).map((file) => {
      const body = fs.readFileSync(file, 'utf8');
      return {
        uri: `memory://${query.scope.scope}/${path.basename(file, '.md')}`,
        kind: this.frontmatter(body).kind ?? 'event',
        body,
        score: 1,
        layer: 'l2' as const,
        tokens: Math.ceil(body.length / 4),
      };
    });
  }

  async extract(): Promise<ExtractionResult> {
    // Extraction is driven by the operations domain and writes results back into `.this`.
    return { adds: [], updates: [], deletes: [], diffPath: '' };
  }

  async promote(from: ScopeRef, to: ScopeRef, opts?: PromoteOpts): Promise<PromotionDiff> {
    // Move files from the narrower subtree to the wider one; record a promotion-diff.json.
    void from; void to; void opts;
    return { promoted: [], skipped: [], diffPath: '' };
  }

  async export(scope: ScopeRef): Promise<ExportPack> {
    return { format: 'markdown', scope, records: this.readTree(SCOPE_DIR[scope.scope](scope.id)) };
  }
  async import(pack: ExportPack): Promise<ImportReport> {
    void pack;
    return { imported: 0, skipped: 0, recomputed: 0, errors: [] };
  }
  async renderAgentsMd(scope: ScopeRef): Promise<string> {
    return this.readTree(SCOPE_DIR[scope.scope](scope.id)).join('\n\n');
  }

  async backendTest(): Promise<CapabilityReport> {
    return {
      plugin: this.name, version: '1.0.0', capabilities: this.capabilities,
      healthy: fs.existsSync(this.root),
      diagnostics: fs.existsSync(this.root) ? undefined : `.this missing at ${this.root}`,
    };
  }
  async diff(sessionId: string): Promise<MemoryDiff> {
    return { sessionId, operations: [], reversible: true };
  }
  async stats(scope?: ScopeRef): Promise<MemoryStats> {
    return {
      scope: scope ?? { scope: 'project', id: '.' }, totalRecords: 0,
      byKind: {} as MemoryStats['byKind'], writtenNeverRead: 0, avgAge: 0, staleCount: 0,
    };
  }

  // --- helpers ---
  private toMarkdown(record: RecordInput, meta: RecordMeta): string {
    const fm = [
      '---',
      `kind: ${record.kind}`,
      `grounding: ${JSON.stringify(record.grounding)}`,
      meta.confidence != null ? `confidence: ${meta.confidence}` : '',
      meta.tags?.length ? `tags: [${meta.tags.join(', ')}]` : '',
      '---',
    ].filter(Boolean).join('\n');
    return `${fm}\n\n${record.body}\n`;
  }
  private frontmatter(body: string): { kind?: RecordInput['kind'] } {
    const m = body.match(/^---\n([\s\S]*?)\n---/);
    const kind = m?.[1].match(/kind:\s*(\S+)/)?.[1];
    return { kind: kind as RecordInput['kind'] | undefined };
  }
  private readTree(rel: string): string[] {
    const dir = path.join(this.root, rel);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { recursive: true, withFileTypes: true } as any)
      .filter((e: any) => e.isFile())
      .map((e: any) => fs.readFileSync(path.join(e.path ?? dir, e.name), 'utf8'));
  }
}
