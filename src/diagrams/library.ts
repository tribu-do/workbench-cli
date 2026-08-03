/**
 * Managed Diagram Library — .workbench/diagrams/
 *
 * Owns the on-disk layout and canonical index for every managed diagram
 * artifact. Shared by the `diagram.create` tool and the `workbench diagrams`
 * CLI family — neither talks to the filesystem or index.json directly.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveWorkbenchDir } from '../config.js';

// ── Paths ────────────────────────────────────────────────────────────────

/** .workbench/diagrams/ */
export function resolveDiagramsDir(): string {
  return path.join(resolveWorkbenchDir(), 'diagrams');
}

/** .workbench/diagrams/index.json */
export function resolveDiagramIndexPath(): string {
  return path.join(resolveDiagramsDir(), 'index.json');
}

// ── Types ────────────────────────────────────────────────────────────────

export interface DiagramEntry {
  uuid: string;
  /** Absolute path to the managed .excalidraw file. */
  filePath: string;
  createdAt: string;
  updatedAt: string;
}

export interface DiagramIndex {
  version: 1;
  diagrams: DiagramEntry[];
}

// ── Index I/O ────────────────────────────────────────────────────────────

export class DiagramIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiagramIndexError';
  }
}

export function loadDiagramIndex(): DiagramIndex {
  const indexPath = resolveDiagramIndexPath();
  if (!fs.existsSync(indexPath)) return { version: 1, diagrams: [] };

  try {
    const raw = fs.readFileSync(indexPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<DiagramIndex>;
    return { version: 1, diagrams: parsed.diagrams ?? [] };
  } catch (err) {
    throw new DiagramIndexError(`Could not read diagram index at ${indexPath}: ${(err as Error).message}`);
  }
}

export function saveDiagramIndex(index: DiagramIndex): void {
  const dir = resolveDiagramsDir();
  fs.mkdirSync(dir, { recursive: true });
  const indexPath = resolveDiagramIndexPath();
  try {
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8');
  } catch (err) {
    throw new DiagramIndexError(`Could not write diagram index at ${indexPath}: ${(err as Error).message}`);
  }
}

// ── Slug + filename ──────────────────────────────────────────────────────

const MAX_SLUG_LENGTH = 60;

/** Turn free text into a filesystem-safe kebab-case slug. */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
  return slug || 'diagram';
}

/** `<uuid>--<slug>.excalidraw` */
export function managedFileName(uuid: string, slug: string): string {
  return `${uuid}--${slug}.excalidraw`;
}

/** Parse the slug back out of a managed file's basename. */
export function slugFromManagedFileName(fileName: string): string {
  const base = fileName.replace(/\.excalidraw$/, '');
  const sepIndex = base.indexOf('--');
  return sepIndex === -1 ? base : base.slice(sepIndex + 2);
}

// ── Resolve / self-heal ──────────────────────────────────────────────────

export class DiagramNotFoundError extends Error {
  constructor(filePath: string) {
    super(
      `No managed diagram at ${filePath}. It may have been moved or edited outside Workbench ` +
      `— re-register it with \`workbench diagrams register ${filePath}\`.`,
    );
    this.name = 'DiagramNotFoundError';
  }
}

/**
 * Resolve a managed diagram entry by absolute file path.
 * Auto-deletes the index entry when the recorded path no longer exists on
 * disk, then throws DiagramNotFoundError so the caller tells the user to
 * re-register — Workbench never re-links a stale entry automatically.
 */
export function resolveManagedDiagram(filePath: string): DiagramEntry {
  const index = loadDiagramIndex();
  const entry = index.diagrams.find((d) => d.filePath === filePath);
  if (!entry) throw new DiagramNotFoundError(filePath);

  if (!fs.existsSync(entry.filePath)) {
    saveDiagramIndex({
      version: 1,
      diagrams: index.diagrams.filter((d) => d.uuid !== entry.uuid),
    });
    throw new DiagramNotFoundError(filePath);
  }

  return entry;
}

/** List every managed diagram, pruning stale entries whose file is gone. */
export function listManagedDiagrams(): DiagramEntry[] {
  const index = loadDiagramIndex();
  const live = index.diagrams.filter((d) => fs.existsSync(d.filePath));
  if (live.length !== index.diagrams.length) {
    saveDiagramIndex({ version: 1, diagrams: live });
  }
  return live;
}

// ── Mutations ────────────────────────────────────────────────────────────

export class DiagramPersistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiagramPersistError';
  }
}

export class DiagramRegisterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiagramRegisterError';
  }
}

function registerEntry(entry: DiagramEntry): void {
  const index = loadDiagramIndex();
  if (index.diagrams.some((d) => d.uuid === entry.uuid)) {
    throw new Error(`uuid ${entry.uuid} already exists in the index`);
  }
  index.diagrams.push(entry);
  saveDiagramIndex(index); // may throw DiagramIndexError — left uncaught here on purpose
}

/**
 * Write new diagram content as a managed artifact and register it.
 * Used by `diagram.create` (src/diagrams/create.ts), which maps the errors
 * this throws onto its typed failure categories.
 */
export function createManagedDiagram(
  content: string,
  opts: { slugSource: string; slugOverride?: string },
): DiagramEntry {
  const dir = resolveDiagramsDir();
  const uuid = crypto.randomUUID();
  const slug = opts.slugOverride ? slugify(opts.slugOverride) : slugify(opts.slugSource);
  const filePath = path.join(dir, managedFileName(uuid, slug));

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
  } catch (err) {
    throw new DiagramPersistError(`Could not write managed diagram file at ${filePath}: ${(err as Error).message}`);
  }

  const now = new Date().toISOString();
  const entry: DiagramEntry = { uuid, filePath, createdAt: now, updatedAt: now };

  try {
    registerEntry(entry);
  } catch (err) {
    fs.rmSync(filePath, { force: true }); // don't leave an unregistered file behind
    if (err instanceof DiagramIndexError) throw err; // surfaces as index_write_failed
    throw new DiagramRegisterError(`Could not register managed diagram ${uuid}: ${(err as Error).message}`);
  }

  return entry;
}

/**
 * Move an existing .excalidraw file into .workbench/diagrams/ and register
 * it as a new managed artifact. Used by `workbench diagrams register`.
 */
export function registerManagedDiagram(sourcePath: string, opts?: { slug?: string }): DiagramEntry {
  const resolvedSource = path.resolve(sourcePath);
  if (!fs.existsSync(resolvedSource)) {
    throw new Error(`No file at ${resolvedSource} to register.`);
  }

  const dir = resolveDiagramsDir();
  fs.mkdirSync(dir, { recursive: true });

  const uuid = crypto.randomUUID();
  const sourceBase = path.basename(resolvedSource, path.extname(resolvedSource));
  const slug = opts?.slug ? slugify(opts.slug) : slugify(sourceBase);
  const filePath = path.join(dir, managedFileName(uuid, slug));

  fs.renameSync(resolvedSource, filePath);

  const now = new Date().toISOString();
  const entry: DiagramEntry = { uuid, filePath, createdAt: now, updatedAt: now };
  registerEntry(entry);
  return entry;
}

/**
 * Straight copy of an existing managed diagram to a new UUID + file path.
 * No prompt-guided improvement here — that is left to the calling agent
 * after duplication, per the CLI Operations REQ.
 */
export function duplicateManagedDiagram(sourceFilePath: string): DiagramEntry {
  const source = resolveManagedDiagram(sourceFilePath);

  const dir = resolveDiagramsDir();
  const uuid = crypto.randomUUID();
  const slug = slugFromManagedFileName(path.basename(source.filePath));
  const filePath = path.join(dir, managedFileName(uuid, slug));

  fs.copyFileSync(source.filePath, filePath);

  const now = new Date().toISOString();
  const entry: DiagramEntry = { uuid, filePath, createdAt: now, updatedAt: now };
  registerEntry(entry);
  return entry;
}

/** Delete the managed file and its index entry immediately after it resolves. */
export function deleteManagedDiagram(filePath: string): void {
  const entry = resolveManagedDiagram(filePath);

  fs.rmSync(entry.filePath, { force: true });

  const index = loadDiagramIndex();
  saveDiagramIndex({
    version: 1,
    diagrams: index.diagrams.filter((d) => d.uuid !== entry.uuid),
  });
}
