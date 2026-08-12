/**
 * CLI entry point — Registers all commands and runs the program.
 */

import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { registerInitCommand } from './commands/init.js';
import { registerTaskCommand } from './commands/task.js';
import { registerSessionCommand } from './commands/session.js';
import { registerSkillCommand } from './commands/skill.js';
import { registerMemoryCommand } from './commands/memory.js';
import { registerDeployCommand } from './commands/deploy.js';
import { registerSecretCommand } from './commands/secret.js';
import { registerHelloCommand } from './commands/hello.js';
import { registerGcCommand } from './commands/gc.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerDocsCommand } from './commands/docs.js';
import { registerDiagramsCommand } from './commands/diagrams.js';
import { createWorkbench } from './context.js';
import { findConfigPath } from '../config.js';
import * as ui from './ui.js';
import type { Task } from '../types.js';

type WorkspaceState = 'uninitialized' | 'partial' | 'ready';

const packageVersion = (
  JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

/**
 * Determine setup completeness from the filesystem (file-first — no DB):
 *   uninitialized — no workbench.yaml found.
 *   partial       — manifest exists but the .workbench/ state tree is missing.
 *   ready         — manifest + .workbench/ tree present.
 */
function detectWorkspaceState(): WorkspaceState {
  const configPath = findConfigPath();
  if (!configPath) return 'uninitialized';
  const workbenchDir = path.join(path.dirname(configPath), '.workbench');
  if (!fs.existsSync(workbenchDir)) return 'partial';
  return 'ready';
}

/** Build the `/command — description` palette from registered top-level commands. */
function commandOptions(program: Command): ui.SelectOption<string>[] {
  return program.commands
    .filter((c) => c.name() !== 'help')
    .map((c) => ({
      value: c.name(),
      label: `/${c.name()}`,
      hint: c.description(),
    }));
}

async function runRoot(program: Command): Promise<void> {
  ui.intro('AI-first sandboxed agentic development workbench');

  const state = detectWorkspaceState();

  if (state === 'uninitialized') {
    ui.note('Type /init to get started', 'Welcome');
    return;
  }

  if (state === 'partial') {
    ui.note('Configuration looks incomplete. Run /doctor to see what needs attention.', 'Heads up');
    return;
  }

  // ready — boxed callout (REQ criterion 4) then the arrow-key palette.
  const options = commandOptions(program);
  ui.note(
    options.map((o) => `${o.label.padEnd(16)} ${o.hint ?? ''}`.trimEnd()).join('\n'),
    'Available Commands:',
  );

  const picked = await ui.commandMenu({
    message: 'Available Commands:',
    options,
  });

  if (picked) {
    ui.log.step(`Run: workbench ${picked}`);
  }
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name('workbench')
    .description('AI-first sandboxed agentic development workbench')
    .version(packageVersion)
    .option('--no-interactive', 'Disable interactive prompts (agent/CI mode)');

  program.hook('preAction', (thisCommand) => {
    // Commander maps `--no-interactive` to opts().interactive === false
    ui.setNonInteractive(thisCommand.opts().interactive === false);
  });

  registerHelloCommand(program);
  registerDoctorCommand(program);
  registerDocsCommand(program);
  registerDiagramsCommand(program);
  registerInitCommand(program);
  registerSessionCommand(program);
  registerTaskCommand(program);
  registerSkillCommand(program);
  registerMemoryCommand(program);
  registerDeployCommand(program);
  registerSecretCommand(program);
  registerGcCommand(program);

  // Status command (quick overview)
  program
    .command('status')
    .description('Show workspace status')
    .action(async () => {
      const wb = createWorkbench();
      try {
        const { tasks, active, leases } = await ui.spin('Reading workspace status', async () => {
          const tasks = wb.orchestrator.listTasks();
          const active = tasks.filter((t: Task) => !['merged', 'aborted'].includes(t.state));
          const leases = wb.portAllocator.list();
          return { tasks, active, leases };
        });

        ui.log.info(`Workspace: ${wb.config.workspace.name} (${wb.config.workspace.id})`);
        ui.log.info(`Runtime:   ${wb.config.runtime.mode}`);
        ui.log.info(`Preview:   ${wb.config.preview.default}`);
        ui.log.info(`Tasks:     ${active.length} active / ${tasks.length} total`);
        ui.log.info(`Ports:     ${leases.length} active`);

        if (active.length > 0) {
          const lines = active.map((t: Task) => `${t.id.slice(0, 8)} [${t.state}] ${t.name}`).join('\n');
          ui.note(lines, 'Active tasks');
        }
      } finally {
        wb.close();
      }
    });

  // Root command: banner + state-aware guidance when invoked with no subcommand.
  program.action(async () => {
    await runRoot(program);
  });

  return program;
}
