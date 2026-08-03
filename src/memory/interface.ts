/**
 * Memory plugin contract — the single interface between Workbench and any memory backend.
 *
 * The built-in filesystem `.this` layer is the default plugin and the source of truth;
 * OpenViking is an optional plugin that indexes over `.this`. Any backend implementing this
 * interface can be registered. No SQLite.
 */

/** The canonical contract every memory backend implements. */
export interface MemoryPlugin {
  readonly name: string;
  readonly capabilities: PluginCapabilities;

  // WRITE — assign where a record lives; returns a stable URI. The reversible audit record is
  // produced at the session boundary by extract() into the journal's memory-diff.json and surfaced
  // by diff(sessionId) — put() itself does not emit a per-write diff (no session context here).
  put(scope: ScopeRef, record: RecordInput, meta: RecordMeta): Promise<RecordUri>;

  // EXTRACTION — episodic → semantic/procedural at a session boundary.
  extract(sessionId: string): Promise<ExtractionResult>;

  // RETRIEVAL — useful, budgeted, layered.
  search(query: SearchQuery): Promise<RankedRecord[]>;

  // PROMOTION — narrow → wide, winner-only under fanout.
  promote(from: ScopeRef, to: ScopeRef, opts?: PromoteOpts): Promise<PromotionDiff>;

  // PORTABILITY — export/import + render interop Markdown.
  export(scope: ScopeRef): Promise<ExportPack>;
  import(pack: ExportPack): Promise<ImportReport>;
  renderAgentsMd(scope: ScopeRef): Promise<string>;

  // ADMIN — capability discovery, audit, stats.
  backendTest(): Promise<CapabilityReport>;
  diff(sessionId: string): Promise<MemoryDiff>;
  stats(scope?: ScopeRef): Promise<MemoryStats>;
}

export interface PluginCapabilities {
  scopes: Scope[];
  features: PluginFeature[];
}

export type PluginFeature = 'vector' | 'rerank' | 'graph' | 'relations' | 'export' | 'l0l1l2';

export type Scope = 'org' | 'user' | 'agent' | 'project' | 'task' | 'session';

export interface ScopeRef {
  scope: Scope;
  id: string;
}

export type RecordKind =
  | 'decision' | 'constraint' | 'preference' | 'case' | 'pattern'
  | 'tool-lesson' | 'skill' | 'entity' | 'event';

export interface RecordInput {
  kind: RecordKind;
  body: string;
  grounding: GroundingRef[];   // required — at least one; ungrounded records are rejected
}

export interface RecordMeta {
  confidence?: number;
  expiresAt?: string;
  tags?: string[];
}

export interface GroundingRef {
  type: 'turn' | 'tool-output' | 'test-result' | 'file' | 'commit';
  uri: string;
  excerpt?: string;
}

/**
 * Scheme-neutral record locator. The built-in layer resolves it to a path under
 * `.workbench/memory/.this/`. Example: "memory://user/decisions/use-file-first-store".
 */
export type RecordUri = string;

export interface ExtractionResult {
  adds: ExtractedRecord[];
  updates: ExtractedRecord[];
  deletes: string[];   // URIs
  diffPath: string;    // path to memory-diff.json inside the task journal
}

export interface ExtractedRecord {
  uri: RecordUri;
  kind: RecordKind;
  body: string;
  grounding: GroundingRef[];
  suggestedPromoteTo?: Scope;
}

export interface SearchQuery {
  query: string;
  scope: ScopeRef;
  sessionId?: string;
  budget: number;                       // max tokens
  intent?: boolean;                     // intent-aware retrieval
  layers?: ('l0' | 'l1' | 'l2')[];
}

export interface RankedRecord {
  uri: RecordUri;
  kind: RecordKind;
  body: string;
  score: number;
  layer: 'l0' | 'l1' | 'l2';
  tokens: number;
}

export interface PromoteOpts {
  winnerOnly?: boolean;
  filter?: (r: ExtractedRecord) => boolean;
}

export interface PromotionDiff {
  promoted: RecordUri[];
  skipped: RecordUri[];
  diffPath: string;
}

export interface ExportPack {
  format: 'ovpack' | 'markdown';
  scope: ScopeRef;
  records: unknown;
  embeddingModel?: string;
}

export interface ImportReport {
  imported: number;
  skipped: number;
  recomputed: number;
  errors: string[];
}

export interface CapabilityReport {
  plugin: string;
  version: string;
  capabilities: PluginCapabilities;
  healthy: boolean;
  diagnostics?: string;
}

export interface MemoryDiff {
  sessionId: string;
  operations: DiffOperation[];
  reversible: boolean;   // the session's memory-diff.json captures before/after per operation,
                         // so a committed session's diff is reversible; produced by extract(),
                         // read by diff(sessionId). Not emitted per individual put().
}

export interface DiffOperation {
  type: 'add' | 'update' | 'delete' | 'promote';
  uri: RecordUri;
  before?: string;
  after?: string;
  timestamp: string;
}

export interface MemoryStats {
  scope: ScopeRef;
  totalRecords: number;
  byKind: Record<RecordKind, number>;
  writtenNeverRead: number;
  avgAge: number;
  staleCount: number;
}
