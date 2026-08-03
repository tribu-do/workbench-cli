/**
 * CLI: workbench memory — Memory query and management commands.
 */

import type { Command } from 'commander';
import { Command as CommanderCommand } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorkbench } from '../context.js';
import { resolveMemoryThisDir } from '../../config.js';
import * as ui from '../ui.js';
import type { Scope } from '../../types.js';

/** Resolve a caller path relative to a `.this` subtree, blocking escapes. */
function resolveIn(sub: string, rel = ''): string {
  const base = path.join(resolveMemoryThisDir(), sub);
  const abs = path.resolve(base, rel);
  if (!abs.startsWith(path.resolve(base))) throw new Error(`Path escapes ${sub}: ${rel}`);
  return abs;
}

/** Attach the shared ls/read/add/grep/rm verbs to a noun bound to a `.this` subtree. */
function fileFamily(parent: CommanderCommand, noun: string, sub: string): CommanderCommand {
  const cmd = parent.command(noun).description(`Browse and edit .this/${sub}`);
  cmd.command('ls [relpath]').description('List entries').action((rel = '') => {
    const dir = resolveIn(sub, rel);
    if (!fs.existsSync(dir)) return ui.log.warn(`Empty: .this/${sub}/${rel}`);
    for (const e of fs.readdirSync(dir, { withFileTypes: true }))
      ui.log.info(e.isDirectory() ? `${e.name}/` : e.name);
  });
  cmd.command('read <relpath>').description('Print a file').action((rel) => {
    process.stdout.write(fs.readFileSync(resolveIn(sub, rel), 'utf8'));
  });
  cmd.command('add <relpath>').description('Create/overwrite a file')
    .option('--text <text>', 'Inline content').option('--from <file>', 'Copy from a source file')
    .action((rel, opts) => {
      const abs = resolveIn(sub, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const content = opts.from ? fs.readFileSync(opts.from, 'utf8') : (opts.text ?? '') + '\n';
      fs.writeFileSync(abs, content);
      ui.log.success(`Wrote .this/${sub}/${rel}`);
    });
  cmd.command('grep <pattern>').description('Search the subtree').action((pattern) => {
    try { process.stdout.write(execFileSync('grep', ['-rn', pattern, resolveIn(sub)], { encoding: 'utf8' })); }
    catch { ui.log.warn('No matches'); }
  });
  cmd.command('rm <relpath>').description('Remove a file').action((rel) => {
    fs.rmSync(resolveIn(sub, rel), { recursive: true, force: true });
    ui.log.success(`Removed .this/${sub}/${rel}`);
  });
  return cmd;
}

/**
 * Register the path-first `.this` command tree onto the `memory` command. Additive to the
 * hierarchical record commands (put/get/list/search/promote/delete): this surface mirrors the
 * durable `.this` tree and addresses files directly. Plugin activation and harness operations
 * (extract/promote/inject) are out of scope here.
 */
function registerThisTree(memory: CommanderCommand): void {
  const thisCmd = memory.command('this').description('Inspect the .this root');
  thisCmd.command('show').action(() => ui.log.info(resolveMemoryThisDir()));
  thisCmd.command('tree').action(() => {
    const root = resolveMemoryThisDir();
    try { process.stdout.write(execFileSync('find', [root, '-maxdepth', '3'], { encoding: 'utf8' })); }
    catch { ui.log.warn(`No .this tree at ${root}`); }
  });

  fileFamily(memory, 'resources', 'resources');
  fileFamily(memory, 'user', 'user');
  fileFamily(memory, 'agents', 'agents');

  // journals add `open` (mkdir a task journal) and `append` (add to a section).
  const journals = fileFamily(memory, 'journals', 'journals');
  journals.command('open <relpath>').description('Create a dated task journal dir').action((rel) => {
    fs.mkdirSync(resolveIn('journals', rel), { recursive: true });
    ui.log.success(`Opened .this/journals/${rel}`);
  });
  journals.command('append <relpath>').description('Append to a journal section')
    .requiredOption('--section <name>').requiredOption('--text <text>')
    .action((rel, opts) => {
      const abs = path.join(resolveIn('journals', rel), 'journal.md');
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.appendFileSync(abs, `\n## ${opts.section}\n${opts.text}\n`);
      ui.log.success(`Appended to ${rel}/journal.md`);
    });
}

export function registerMemoryCommand(program: Command): void {
  const memory = program
    .command('memory')
    .description('Manage hierarchical memory records and inspect the .this tree');

  memory
    .command('put <namespace> <key>')
    .description('Store a memory record')
    .option('-s, --scope <scope>', 'Scope (global|workspace|session|task)', 'global')
    .option('--scope-id <scopeId>', 'Scope ID', 'global')
    .option('-b, --body <body>', 'Record body (or pipe from stdin)')
    .action((namespace, key, opts) => {
      const wb = createWorkbench();
      try {
        const body = opts.body ?? '';
        const record = wb.memoryService.put(
          opts.scope as Scope, opts.scopeId, namespace, key, body,
        );
        console.log(`Stored: ${record.id} (${record.scope}/${record.scopeId}/${namespace}/${key})`);
      } finally {
        wb.close();
      }
    });

  memory
    .command('get <namespace> <key>')
    .description('Retrieve a memory record (walks scope cascade)')
    .option('--task-id <taskId>', 'Task context')
    .option('--session-id <sessionId>', 'Session context')
    .option('--workspace-id <workspaceId>', 'Workspace context')
    .action((namespace, key, opts) => {
      const wb = createWorkbench();
      try {
        const record = wb.memoryService.get(namespace, key, {
          taskId: opts.taskId,
          sessionId: opts.sessionId,
          workspaceId: opts.workspaceId ?? wb.config.workspace.id,
        });

        if (!record) {
          console.log('Not found.');
          process.exit(1);
        }

        console.log(`[${record.scope}/${record.scopeId}] ${record.namespace}/${record.key}`);
        console.log(record.body);
      } finally {
        wb.close();
      }
    });

  memory
    .command('list')
    .description('List memory records')
    .option('-s, --scope <scope>', 'Scope', 'global')
    .option('--scope-id <scopeId>', 'Scope ID', 'global')
    .option('-n, --namespace <namespace>', 'Filter by namespace')
    .action((opts) => {
      const wb = createWorkbench();
      try {
        const records = wb.memoryService.list(opts.scope as Scope, opts.scopeId, opts.namespace);

        if (records.length === 0) {
          console.log('No records found.');
          return;
        }

        for (const r of records) {
          const preview = r.body.length > 60 ? r.body.slice(0, 60) + '...' : r.body;
          console.log(`${r.id.slice(0, 8)}  [${r.scope}] ${r.namespace}/${r.key}: ${preview}`);
        }
      } finally {
        wb.close();
      }
    });

  memory
    .command('search <query>')
    .description('Search memory records by content')
    .option('-s, --scope <scope>', 'Filter by scope')
    .option('--scope-id <scopeId>', 'Filter by scope ID')
    .action((query, opts) => {
      const wb = createWorkbench();
      try {
        const records = wb.memoryService.search(query, opts.scope, opts.scopeId);

        if (records.length === 0) {
          console.log('No matches found.');
          return;
        }

        for (const r of records) {
          const preview = r.body.length > 60 ? r.body.slice(0, 60) + '...' : r.body;
          console.log(`${r.id.slice(0, 8)}  [${r.scope}] ${r.namespace}/${r.key}: ${preview}`);
        }
      } finally {
        wb.close();
      }
    });

  memory
    .command('promote <id>')
    .description('Promote a memory record to a higher scope')
    .option('--to-scope <scope>', 'Target scope', 'global')
    .option('--to-id <scopeId>', 'Target scope ID', 'global')
    .action((id, opts) => {
      const wb = createWorkbench();
      try {
        const record = wb.memoryService.promote(id, opts.toScope as Scope, opts.toId);
        console.log(`Promoted to ${record.scope}/${record.scopeId}.`);
      } finally {
        wb.close();
      }
    });

  memory
    .command('delete <id>')
    .description('Delete a memory record')
    .action((id) => {
      const wb = createWorkbench();
      try {
        const deleted = wb.memoryService.delete(id);
        console.log(deleted ? 'Deleted.' : 'Not found.');
      } finally {
        wb.close();
      }
    });

  // Path-first `.this` tree surface (additive; mirrors .workbench/memory/.this/).
  registerThisTree(memory);
}
