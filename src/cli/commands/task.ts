/**
 * CLI: workbench task — Task lifecycle commands.
 */

import type { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { createWorkbench } from '../context.js';
import { runTaskWizard, readLLDContent } from './task-wizard.js';
import type { TaskState } from '../../types.js';

export function registerTaskCommand(program: Command): void {
  const task = program
    .command('task')
    .description('Manage tasks');

  // Interactive wizard
  task
    .command('new')
    .description('Create a task using the interactive wizard')
    .option('--start', 'Start the agent immediately after creation')
    .action(async (opts) => {
      const wb = createWorkbench();
      try {
        const spec = await runTaskWizard(wb);
        if (!spec) {
          return;
        }

        const task = await wb.orchestrator.createTask(spec);

        console.log(`\nTask created: ${task.id}`);
        console.log(`  Name:      ${task.name}`);
        console.log(`  Branch:    ${task.branch}`);
        console.log(`  State:     ${task.state}`);

        if (opts.start) {
          console.log('\nStarting agent...');

          const lldFile = spec.metadata?.lldFile as string | undefined;
          const lldContent = lldFile ? readLLDContent(lldFile) : null;
          const prompt = lldContent
            ? `Please implement the following:\n\n${lldContent}`
            : undefined;

          const provider = wb.getAgentProvider(task.aiAgentProvider as 'claude');
          if (provider.isAvailable()) {
            const worktreePath = (task.metadata.worktreePath as string) ?? process.cwd();
            await provider.launch({
              taskId: task.id,
              worktreePath,
              containerId: task.metadata.containerId as string | undefined,
              prompt,
              autoApprove: task.autoApprove,
            });
          } else {
            console.log(`Agent "${task.aiAgentProvider}" not available. Run \`workbench task attach ${task.id}\` when ready.`);
          }
        } else {
          console.log(`\nRun \`workbench task attach ${task.id}\` to start the agent.`);
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      } finally {
        wb.close();
      }
    });

  // Direct create (non-wizard)
  task
    .command('create <name>')
    .description('Create a new task')
    .option('-b, --branch <branch>', 'Git branch name')
    .option('-m, --mode <mode>', 'Runtime mode')
    .option('-p, --provider <provider>', 'AI agent provider (claude|codex|copilot)')
    .option('--no-auto-approve', 'Disable auto-approve for tool calls (default: enabled)')
    .option('--port <ports...>', 'Ports to allocate (name:number or just number)')
    .option('--secret <secrets...>', 'Secret keys this task needs')
    .action(async (name, opts) => {
      const wb = createWorkbench();
      try {
        const ports = opts.port?.map((p: string) => {
          const [portName, portNum] = p.includes(':') ? p.split(':') : [`port-${p}`, p];
          return { name: portName, port: parseInt(portNum, 10) || undefined };
        });

        const task = await wb.orchestrator.createTask({
          name,
          branch: opts.branch,
          runtimeMode: opts.mode,
          aiAgentProvider: opts.provider,
          autoApprove: opts.autoApprove,
          ports,
          secrets: opts.secret,
        });

        console.log(`Task created: ${task.id}`);
        console.log(`  Name:      ${task.name}`);
        console.log(`  Branch:    ${task.branch}`);
        console.log(`  State:     ${task.state}`);
        console.log(`  Mode:      ${task.runtimeMode}`);
        console.log(`  Isolation: ${task.isolationTier}`);
        console.log(`  Provider:  ${task.aiAgentProvider}`);
        console.log(`  Auto-approve: ${task.autoApprove}`);

        if (task.runtimeMode === 'bare-host') {
          const missingAgents = ['claude', 'codex', 'copilot'].filter((agent) => !commandAvailable(agent));
          if (missingAgents.length > 0) {
            console.log('');
            console.log('Notice: bare-host mode uses local agent CLIs from your current terminal session.');
            console.log(`  Missing agents in PATH: ${missingAgents.join(', ')}`);
            console.log('  Run `npm run workbench -- doctor` for environment diagnostics.');
          }
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      } finally {
        wb.close();
      }
    });

  task
    .command('list')
    .description('List tasks')
    .option('-s, --state <state>', 'Filter by state')
    .action((opts) => {
      const wb = createWorkbench();
      try {
        const tasks = wb.orchestrator.listTasks({ state: opts.state as TaskState });

        if (tasks.length === 0) {
          console.log('No tasks found.');
          return;
        }

        console.log('ID                                    State              Name');
        console.log('─'.repeat(72));
        for (const t of tasks) {
          const id = t.id.padEnd(37);
          const state = t.state.padEnd(18);
          console.log(`${id} ${state} ${t.name}`);
        }
      } finally {
        wb.close();
      }
    });

  task
    .command('status <taskId>')
    .description('Show task details')
    .action((taskId) => {
      const wb = createWorkbench();
      try {
        const t = wb.orchestrator.getTask(taskId);
        if (!t) {
          console.error(`Task ${taskId} not found.`);
          process.exit(1);
        }

        console.log(`Task: ${t.name} (${t.id})`);
        console.log(`  State:         ${t.state}`);
        console.log(`  Branch:        ${t.branch}`);
        console.log(`  Runtime mode:  ${t.runtimeMode}`);
        console.log(`  Isolation:     ${t.isolationTier}`);
        console.log(`  Provider:      ${t.aiAgentProvider}`);
        console.log(`  Auto-approve:  ${t.autoApprove}`);
        console.log(`  Created:       ${t.createdAt}`);
        console.log(`  Updated:       ${t.updatedAt}`);

        // Port leases — file-first leases are keyed by sessionId
        const leases = wb.portAllocator.list({ sessionId: t.sessionId });
        if (leases.length > 0) {
          console.log('  Ports:');
          for (const l of leases) {
            console.log(`    ${l.name}: ${l.port}/${l.protocol}`);
          }
        }

        // Recent events
        const events = wb.orchestrator.getEvents(taskId).slice(-5);
        if (events.length > 0) {
          console.log('  Recent events:');
          for (const e of events) {
            console.log(`    ${e.timestamp} ${e.kind}`);
          }
        }
      } finally {
        wb.close();
      }
    });

  task
    .command('transition <taskId> <state>')
    .description('Transition a task to a new state')
    .action((taskId, state) => {
      const wb = createWorkbench();
      try {
        const t = wb.orchestrator.transitionTask(taskId, state as TaskState);
        console.log(`Task ${t.id} transitioned to ${t.state}.`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      } finally {
        wb.close();
      }
    });

  task
    .command('abort <taskId>')
    .description('Abort a task (releases ports, stops container, removes worktree)')
    .action((taskId) => {
      const wb = createWorkbench();
      try {
        const t = wb.orchestrator.transitionTask(taskId, 'aborted');
        console.log(`Task ${t.id} aborted.`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      } finally {
        wb.close();
      }
    });

  task
    .command('attach <taskId>')
    .description('Launch the AI agent for a task (interactive)')
    .option('--prompt <prompt>', 'Initial prompt to send to the agent')
    .action(async (taskId, opts) => {
      const wb = createWorkbench();
      try {
        const t = wb.orchestrator.getTask(taskId);
        if (!t) {
          console.error(`Task ${taskId} not found.`);
          process.exit(1);
        }
        if (['merged', 'aborted'].includes(t.state)) {
          console.error(`Task is ${t.state}; cannot attach.`);
          process.exit(1);
        }

        const provider = wb.getAgentProvider(t.aiAgentProvider as 'claude');
        if (!provider.isAvailable()) {
          console.error(`Agent provider "${t.aiAgentProvider}" CLI is not installed or not on PATH.`);
          process.exit(1);
        }

        const worktreePath = (t.metadata.worktreePath as string | undefined) ?? process.cwd();
        const containerId = t.metadata.containerId as string | undefined;

        console.log(`Launching ${t.aiAgentProvider} for task ${t.id}...`);
        await provider.launch({
          taskId: t.id,
          worktreePath,
          containerId,
          prompt: opts.prompt,
          autoApprove: t.autoApprove,
        });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      } finally {
        wb.close();
      }
    });
}

function commandAvailable(command: string): boolean {
  try {
    execFileSync(command, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}
