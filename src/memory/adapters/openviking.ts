/**
 * OpenViking memory plugin — optional, toggleable accelerator. It does not own memory: the
 * built-in `.this` layer stays the source of truth; OpenViking indexes over it. Talks to the real
 * OpenViking integration (HTTP server, default http://localhost:1933, `/v1/*` routes) with the
 * embedded Python `SyncOpenViking` SDK as fallback — the same transport proven in
 * `src/memory/backends.ts`. No `@openviking/client` npm package, no direct LanceDB import, no SQLite.
 */

import { execFileSync, spawn } from 'node:child_process';
import { resolveOpenVikingWorkspace } from '../../config.js';
import { FilesystemPlugin } from './filesystem.js';
import type {
  MemoryPlugin, PluginCapabilities, ScopeRef, RecordInput, RecordMeta, RecordUri,
  SearchQuery, RankedRecord, ExtractionResult, PromoteOpts, PromotionDiff,
  ExportPack, ImportReport, CapabilityReport, MemoryDiff, MemoryStats,
} from '../interface.js';

/** No separate client package ships; the version is this adapter's own. */
const OPENVIKING_ADAPTER_VERSION = '1.0.0';

/** A single OpenViking result row as returned by `/v1/find` or the Python `find()`. */
interface OvResult { uri?: string; content?: string; score?: number; kind?: RecordKindLike; }
type RecordKindLike = RankedRecord['kind'];

/**
 * Transport to the real OpenViking integration (mirrors `src/memory/backends.ts`):
 * prefer a running HTTP server (`WORKBENCH_OPENVIKING_URL`, default `http://localhost:1933`);
 * fall back to the embedded Python `SyncOpenViking` SDK via `python3 -c`.
 * No `@openviking/client` npm package is involved.
 */
class OpenVikingTransport {
  private readonly serverUrl = process.env.WORKBENCH_OPENVIKING_URL ?? 'http://localhost:1933';
  private readonly workspace = resolveOpenVikingWorkspace();
  private readonly apiKey = process.env.WORKBENCH_OPENVIKING_API_KEY;

  async isServerReachable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.serverUrl}/health`, { signal: AbortSignal.timeout(1500) });
      return res.ok;
    } catch { return false; }
  }

  async health(): Promise<{ ok: boolean; message?: string }> {
    if (await this.isServerReachable()) return { ok: true };
    if (this.isPythonSdkAvailable()) return { ok: true, message: 'embedded python SDK' };
    return { ok: false, message: 'no OpenViking server and no python SDK' };
  }

  /** Index one `.this` record by writing its body at a derived viking:// uri. */
  async index(uri: string, body: string): Promise<void> {
    if (await this.isServerReachable()) {
      await this.httpPost('/v1/write', { uri, content: body, mode: 'replace' });
      return;
    }
    await this.pyRun(`
from openviking import SyncOpenViking
client = SyncOpenViking(path=${JSON.stringify(this.workspace)})
client.initialize()
client.write(${JSON.stringify(uri)}, ${JSON.stringify(body)}, mode="replace", wait=True)
print("ok")
`);
  }

  async find(query: string, limit: number): Promise<OvResult[]> {
    if (await this.isServerReachable()) {
      const res = await this.httpPost('/v1/find', { query, limit }) as { results?: OvResult[] };
      return res.results ?? [];
    }
    const raw = await this.pyRun(`
import json
from openviking import SyncOpenViking
client = SyncOpenViking(path=${JSON.stringify(this.workspace)})
client.initialize()
results = client.find(${JSON.stringify(query)}, limit=${limit})
print(json.dumps(results if isinstance(results, list) else []))
`);
    try { return JSON.parse(raw) as OvResult[]; } catch { return []; }
  }

  /** Commit a session so OpenViking runs its self-iteration extraction. */
  async commitSession(sessionId: string): Promise<void> {
    if (await this.isServerReachable()) {
      await this.httpPost('/v1/sessions/commit', { session_id: sessionId });
      return;
    }
    await this.pyRun(`
from openviking import SyncOpenViking
client = SyncOpenViking(path=${JSON.stringify(this.workspace)})
client.initialize()
client.commit_session(${JSON.stringify(sessionId)})
print("ok")
`);
  }

  /** Refresh the derived index after `.this` files move (HTTP only, mirrors backends.ts). */
  async sync(): Promise<void> {
    if (await this.isServerReachable()) await this.httpPost('/v1/sync', {});
  }

  // ── HTTP + Python helpers (copied from src/memory/backends.ts) ──────────────
  private async httpPost(p: string, body: unknown): Promise<unknown> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
    const res = await fetch(`${this.serverUrl}${p}`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`OpenViking HTTP POST ${p} → ${res.status}`);
    return res.json();
  }
  private isPythonSdkAvailable(): boolean {
    try { execFileSync('python3', ['-c', 'import openviking'], { stdio: 'ignore', timeout: 3000 }); return true; }
    catch { return false; }
  }
  private pyRun(script: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('python3', ['-c', script], { env: process.env });
      let stdout = ''; let stderr = '';
      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      proc.on('close', (code) => code !== 0
        ? reject(new Error(`openviking py: ${stderr.trim()}`))
        : resolve(stdout.trim()));
    });
  }
}

export class OpenVikingPlugin implements MemoryPlugin {
  readonly name = 'openviking';
  readonly capabilities: PluginCapabilities = {
    scopes: ['org', 'user', 'agent', 'project', 'task', 'session'],
    features: ['vector', 'rerank', 'l0l1l2', 'export'],
  };

  /** The built-in layer holds the source of truth; OpenViking indexes what it writes. */
  private builtin = new FilesystemPlugin();
  private ov = new OpenVikingTransport();

  /** Write to `.this` first, then index. The file is the record; the index is derived. */
  async put(scope: ScopeRef, record: RecordInput, meta: RecordMeta): Promise<RecordUri> {
    const uri = await this.builtin.put(scope, record, meta);   // `.this` is the record of truth
    try { await this.ov.index(uri, record.body); }
    catch { /* index is derived — `.this` already holds the record, so swallow index errors */ }
    return uri;
  }

  /** Vector/intent search over the index; degrade to `.this` grep if OpenViking is unreachable. */
  async search(query: SearchQuery): Promise<RankedRecord[]> {
    try {
      const hits = await this.ov.find(query.query, Math.ceil(query.budget / 50));
      if (hits.length) {
        return hits.map((h) => ({
          uri: h.uri ?? '',
          kind: h.kind ?? 'event',
          body: h.content ?? '',
          score: h.score ?? 1,
          layer: 'l1' as const,
          tokens: Math.ceil((h.content ?? '').length / 4),
        }));
      }
    } catch { /* fall through to the grep floor */ }
    return this.builtin.search(query);
  }

  /**
   * End-of-session extraction. OpenViking's `commit_session` triggers its self-iteration
   * loop (writing extracted records back into `.this`); the shared journal pipeline records the
   * memory-diff. `.this` remains authoritative, so the built-in extract result is returned.
   */
  async extract(sessionId: string): Promise<ExtractionResult> {
    try { await this.ov.commitSession(sessionId); }
    catch { /* commit is best-effort; extraction still degrades to the built-in pipeline */ }
    return this.builtin.extract();
  }

  async promote(from: ScopeRef, to: ScopeRef, opts?: PromoteOpts): Promise<PromotionDiff> {
    const built = await this.builtin.promote(from, to, opts); // moves files in `.this`
    try { await this.ov.sync(); }                             // refresh the derived index
    catch { /* index refreshes lazily on next commit */ }
    return built;
  }

  // Export/import/render resolve from `.this` — no OpenViking-specific pack endpoint ships,
  // so portability rides the built-in Markdown path (honest coverage, not an invented API).
  async export(scope: ScopeRef): Promise<ExportPack> {
    return this.builtin.export(scope);
  }
  async import(pack: ExportPack): Promise<ImportReport> {
    return this.builtin.import(pack);
  }
  async renderAgentsMd(scope: ScopeRef): Promise<string> {
    return this.builtin.renderAgentsMd(scope); // render from the source of truth
  }

  async backendTest(): Promise<CapabilityReport> {
    const health = await this.ov.health();
    return {
      plugin: this.name, version: OPENVIKING_ADAPTER_VERSION, capabilities: this.capabilities,
      healthy: health.ok, diagnostics: health.message,
    };
  }
  async diff(sessionId: string): Promise<MemoryDiff> {
    return this.builtin.diff(sessionId); // diffs live in the `.this` journal
  }
  async stats(scope?: ScopeRef): Promise<MemoryStats> {
    return this.builtin.stats(scope); // no OpenViking stats endpoint ships; use the file tree
  }
}
