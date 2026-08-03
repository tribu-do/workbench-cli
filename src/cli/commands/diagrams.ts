/**
 * CLI: workbench diagrams — Create, duplicate, list, preview, register, and
 * delete Workbench-managed Excalidraw diagrams.
 *
 * Commands:
 *   diagrams create <prompt...>   Create a diagram via the diagram.create tool contract
 *   diagrams duplicate <filepath> Straight copy of a managed diagram
 *   diagrams list                 List managed diagrams
 *   diagrams preview <filepath>   Print a read-only preview URL
 *   diagrams register <filepath>  Move an existing .excalidraw file into the library
 *   diagrams delete <filepath>    Delete a managed diagram
 *
 * Rename is intentionally not part of the v1 CLI surface — see
 * req-diagram-cli-operations.md.
 */

import path from 'node:path';
import type { Command } from 'commander';
import {
  registerManagedDiagram,
  duplicateManagedDiagram,
  deleteManagedDiagram,
  listManagedDiagrams,
  resolveManagedDiagram,
} from '../../diagrams/library.js';
import { diagramCreate } from '../../diagrams/create.js';
import { ensurePreviewService, previewUrlFor } from '../../diagrams/preview.js';
import { log, spin } from '../ui.js';

export function registerDiagramsCommand(program: Command): void {
  const diagrams = program
    .command('diagrams')
    .description('Manage Workbench-managed Excalidraw diagrams');

  // ── create ────────────────────────────────────────────────────────────────
  diagrams
    .command('create <prompt...>')
    .description('Create a new managed diagram from a natural-language prompt')
    .option('--plugin <name>', 'Diagram plugin to use', 'excalidraw')
    .option('--slug <slug>', 'Override the auto-generated slug')
    .option('-v, --verbose', 'Print uuid and full artifact details')
    .action(async (promptParts: string[], opts: { plugin: string; slug?: string; verbose?: boolean }) => {
      const prompt = promptParts.join(' ');
      const result = await spin('Creating diagram', () =>
        diagramCreate({ prompt, plugin: opts.plugin, slug: opts.slug, verbose: opts.verbose }));

      if (!result.ok) {
        log.error(`Diagram create failed: ${result.reason}`);
        console.error(JSON.stringify({ error: result.error, reason: result.reason }, null, 2));
        process.exit(1);
      }

      if (opts.verbose) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(result.filePath);
      }
    });

  // ── duplicate ─────────────────────────────────────────────────────────────
  diagrams
    .command('duplicate <filepath>')
    .description('Create a straight copy of an existing managed diagram')
    .action((filepath: string) => {
      try {
        const entry = duplicateManagedDiagram(path.resolve(filepath));
        console.log(entry.filePath);
      } catch (err) {
        log.error((err as Error).message);
        process.exit(1);
      }
    });

  // ── list ──────────────────────────────────────────────────────────────────
  diagrams
    .command('list')
    .description('List managed diagrams')
    .option('-v, --verbose', 'Include uuid, file path, and preview URL')
    .action((opts: { verbose?: boolean }) => {
      const entries = listManagedDiagrams();
      if (entries.length === 0) {
        console.log('No managed diagrams yet. Run: workbench diagrams create "<prompt>"');
        return;
      }
      if (!opts.verbose) {
        for (const e of entries) console.log(e.filePath);
        return;
      }
      for (const e of entries) {
        console.log(`${e.uuid}  ${e.filePath}  ${previewUrlFor(e.uuid)}`);
      }
    });

  // ── preview ───────────────────────────────────────────────────────────────
  diagrams
    .command('preview <filepath>')
    .description('Print a read-only preview URL for a managed diagram, starting the local viewer if needed')
    .action(async (filepath: string) => {
      try {
        const entry = resolveManagedDiagram(path.resolve(filepath));
        await spin('Starting diagram preview service', () => ensurePreviewService());
        console.log(previewUrlFor(entry.uuid));
      } catch (err) {
        log.error((err as Error).message);
        process.exit(1);
      }
    });

  // ── register ──────────────────────────────────────────────────────────────
  diagrams
    .command('register <filepath>')
    .description('Move an existing .excalidraw file into the managed library')
    .option('--slug <slug>', 'Override the auto-generated slug')
    .action((filepath: string, opts: { slug?: string }) => {
      try {
        const entry = registerManagedDiagram(path.resolve(filepath), { slug: opts.slug });
        console.log(entry.filePath);
      } catch (err) {
        log.error((err as Error).message);
        process.exit(1);
      }
    });

  // ── delete ────────────────────────────────────────────────────────────────
  diagrams
    .command('delete <filepath>')
    .description('Delete a managed diagram and its index entry')
    .action((filepath: string) => {
      try {
        deleteManagedDiagram(path.resolve(filepath));
        console.log(`Deleted ${filepath}`);
      } catch (err) {
        log.error((err as Error).message);
        process.exit(1);
      }
    });

  // NOTE: rename is intentionally not part of the v1 CLI surface
  // (req-diagram-cli-operations.md — "Keep rename out of the v1 CLI surface").
}
