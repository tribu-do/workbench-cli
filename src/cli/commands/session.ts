/**
 * CLI: workbench session — Session lifecycle commands.
 *
 * Key commands:
 *   create  — Create a new session
 *   attach  — Attach to a session (does NOT start agent)
 *   detach  — Detach from session (agent keeps running)
 *   resume  — Resume a paused session
 *   enter   — Enter interactive shell in session container
 *   stop    — End session and cleanup
 */

import type { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { createWorkbench } from '../context.js';
import { SessionManager } from '../../sessions/manager.js';
import type { SessionState } from '../../types.js';
import * as ui from '../ui.js';
import { runSessionCreateWizard } from './session-wizard.js';
import {
  allocateSessionId,
  buildPromptBody,
  createDraftSession,
  findSession,
  writeJournal,
} from '../../sessions/store.js';
import {
  launchSessionRuntime,
  requiredSecretsFor,
  RuntimeLaunchError,
} from '../../runtime/launch.js';
import { findRepoRoot } from '../../runtime/worktree.js';
import { loadCredentials } from '../../config.js';

export function registerSessionCommand(program: Command): void {
  const session = program
    .command('session')
    .description('Manage sessions (working units containing many tasks)');

  session
    .command('create')
    .description('Create a new session via the interactive wizard')
    .action(async () => {
      const wb = createWorkbench();
      try {
        const repoRoot = findRepoRoot() ?? process.cwd();
        const answers = await runSessionCreateWizard(wb, repoRoot);

        // Session id is allocated before any runtime setup — no runtime setup happens in
        // `session create` at all; that is entirely `session start`'s responsibility.
        const sessionId = allocateSessionId();

        const promptBody = buildPromptBody({
          repoRoot,
          reqSources: answers.reqSources,
          taskComponents: answers.taskComponents,
        });

        const { dir, record } = createDraftSession({
          sessionId,
          reqSources: answers.reqSources,
          agent: answers.agent,
          userPreferences: answers.userPreferences,
          agentPreferences: answers.agentPreferences,
          taskComponents: answers.taskComponents,
          worktreeBranch: answers.worktreeBranch,
          runtimeProfile: answers.runtimeProfile,
          runtimeMode: answers.runtimeMode,
          port: answers.port,
          previewEnabled: answers.previewEnabled,
          previewTarget: answers.previewTarget,
          secrets: answers.secrets,
          promptBody,
        });

        ui.note(
          [
            `Session id:    ${record.session_id}`,
            `Record path:   ${dir}`,
            `Prompt path:   ${path.join(dir, 'prompt.md')}`,
            `Agent:         ${record.agent}`,
            `Runtime:       ${record.runtime.profile} (${record.runtime.mode})`,
          ].join('\n'),
          'Draft session created',
        );
        ui.outro('Session recorded as draft.', `workbench session start ${record.session_id}`);
      } finally {
        wb.close();
      }
    });

  session
    .command('start <sessionId>')
    .description('Confirm and launch a draft session in its selected runtime')
    .action(async (sessionId) => {
      // Load `~/.workbench` file-based credentials into process.env before the required-secret
      // loop below — mirrors what `createWorkbench()` does for the `create` wizard, so a secret
      // configured on disk (not exported in the shell) is seen as present instead of re-prompted
      // (or hard-failing in non_interactive mode).
      loadCredentials();

      const found = findSession(sessionId);
      if (!found) {
        ui.log.error(`Session ${sessionId} not found.`);
        process.exit(1);
      }
      const { dir, record } = found;

      if (record.state === 'running') {
        ui.log.error(`Session ${sessionId} is already running.`);
        process.exit(1);
      }

      const promptPath = path.join(dir, 'prompt.md');

      ui.note(
        [
          `Session id:     ${record.session_id}`,
          `REQ sources:    ${record.req_sources.join(', ') || 'none'}`,
          `Agent:          ${record.agent}`,
          `Components:     ${[...record.user_preferences, ...record.agent_preferences, ...record.task_components].join(', ') || 'none'}`,
          `Worktree:       ${record.worktree.branch}`,
          `Runtime:        ${record.runtime.profile} (${record.runtime.mode})`,
          `Port:           ${record.port}`,
          `Preview:        ${record.preview.enabled ? (record.preview.target ?? 'enabled') : 'disabled'}`,
          `Record path:    ${dir}`,
          `Prompt path:    ${promptPath}`,
        ].join('\n'),
        `Confirm session start: ${sessionId}`,
      );

      const confirmed = await ui.confirm({ message: 'Start this session?', default: true });
      if (!confirmed) {
        ui.log.info('Cancelled — session left in draft state.');
        return;
      }

      // Resolve validated secret values (already-configured or freshly prompted) before launch.
      const secretValues: Record<string, string> = {};
      for (const key of requiredSecretsFor(record.agent)) {
        const existing = process.env[key];
        if (existing) {
          secretValues[key] = existing;
          continue;
        }
        if (ui.mode() === 'non_interactive') {
          ui.log.error(`Missing required secret ${key} for agent ${record.agent}.`);
          process.exit(1);
        }
        secretValues[key] = await ui.password({ message: `Value for ${key} (required by ${record.agent})` });
      }

      const promptBody = fs.readFileSync(promptPath, 'utf-8');

      try {
        const result = await ui.spin(`Starting session ${sessionId}`, () =>
          launchSessionRuntime(record, promptBody, secretValues),
        );

        writeJournal(dir, {
          ...record,
          state: 'running',
          updated_at: new Date().toISOString(),
          runtime_state: { pid: result.pid, started_at: result.startedAt },
        });

        ui.log.success(`Session ${result.sessionId} is running.`);
        ui.note(
          [`Session id: ${result.sessionId}`, `State:      ${result.runtimeState}`, `Worktree:   ${result.worktreePath}`].join('\n'),
          'Running session',
        );
      } catch (err) {
        if (err instanceof RuntimeLaunchError) {
          ui.log.error(`[${err.code}] ${err.message}`);
        } else {
          ui.log.error(`Error: ${err instanceof Error ? err.message : err}`);
        }
        process.exit(1);
      }
    });

  session
    .command('list')
    .description('List sessions')
    .option('-s, --state <state>', 'Filter by state')
    .action((opts) => {
      const wb = createWorkbench();
      try {
        const sessions = wb.sessionService.list({
          workspaceId: wb.config.workspace.id || 'default',
          state: opts.state as SessionState,
        });
        const current = wb.sessionService.current();

        if (sessions.length === 0) {
          console.log('No sessions found.');
          return;
        }

        console.log('  ID                                    State    Name');
        console.log('  ' + '─'.repeat(64));
        for (const s of sessions) {
          const marker = current?.id === s.id ? '*' : ' ';
          console.log(`${marker} ${s.id.padEnd(37)} ${s.state.padEnd(8)} ${s.name}`);
        }
        if (current) console.log(`\n* = currently attached`);
      } finally {
        wb.close();
      }
    });

  session
    .command('attach <sessionId>')
    .description('Attach to an existing session as the current one')
    .action((sessionId) => {
      const wb = createWorkbench();
      try {
        wb.sessionService.attach(sessionId);
        console.log(`Attached to session ${sessionId}.`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      } finally {
        wb.close();
      }
    });

  session
    .command('current')
    .description('Show the currently attached session')
    .action(() => {
      const wb = createWorkbench();
      try {
        const current = wb.sessionService.current();
        if (!current) {
          console.log('No session attached.');
          return;
        }
        console.log(`Session: ${current.name} (${current.id})`);
        console.log(`  State: ${current.state}`);
        console.log(`  Mode:  ${current.runtimeMode}`);
        console.log(`  Agent: ${current.agent}`);
      } finally {
        wb.close();
      }
    });

  session
    .command('stop <sessionId>')
    .description('End a session, cleanup resources, and optionally extract memories')
    .option('--extract-memory', 'Extract memories from session before stopping')
    .option('--feedback <feedback>', 'User feedback for memory extraction')
    .action(async (sessionId, opts) => {
      const wb = createWorkbench();
      try {
        const manager = new SessionManager(wb.orchestrator);
        const result = await manager.stopSession(sessionId, {
          extractMemory: opts.extractMemory,
          feedback: opts.feedback,
        });

        console.log(`Session ${result.session.id} ended.`);
        if (result.tasksAborted > 0) {
          console.log(`  ${result.tasksAborted} task(s) aborted.`);
        }
        if (result.memoriesExtracted > 0) {
          console.log(`  ${result.memoriesExtracted} memories extracted.`);
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      } finally {
        wb.close();
      }
    });

  session
    .command('detach [sessionId]')
    .description('Detach from session (agent keeps running in background)')
    .action(async (sessionId) => {
      const wb = createWorkbench();
      try {
        const manager = new SessionManager(wb.orchestrator);
        const current = wb.sessionService.current();
        const targetId = sessionId ?? current?.id;

        if (!targetId) {
          console.error('No session to detach from. Provide sessionId or attach first.');
          process.exit(1);
        }

        await manager.detachSession(targetId);
        console.log(`Detached from session ${targetId}.`);
        console.log('Agent continues running in background. Use `workbench session attach` to reconnect.');
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      } finally {
        wb.close();
      }
    });

  session
    .command('resume <sessionId>')
    .description('Resume a paused session')
    .option('-p, --prompt <prompt>', 'Send a prompt to the agent')
    .action(async (sessionId, opts) => {
      const wb = createWorkbench();
      try {
        const manager = new SessionManager(wb.orchestrator);
        const result = await manager.resumeSession(sessionId, opts.prompt);

        console.log(`Session ${result.session.id} resumed.`);
        console.log(`  State: ${result.session.state}`);
        if (result.agentRestarted) {
          console.log('  Agent was not running; use `workbench task attach` to start it.');
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      } finally {
        wb.close();
      }
    });

  session
    .command('enter [sessionId]')
    .description('Enter interactive shell in session container')
    .action((sessionId) => {
      const wb = createWorkbench();
      try {
        const manager = new SessionManager(wb.orchestrator);
        const current = wb.sessionService.current();
        const targetId = sessionId ?? current?.id;

        if (!targetId) {
          console.error('No session specified. Provide sessionId or attach first.');
          process.exit(1);
        }

        console.log(`Entering session ${targetId}...`);
        console.log('Type "exit" to return to host shell.\n');

        const child = manager.enterSession(targetId);
        if (!child) {
          console.error('No container available for this session.');
          process.exit(1);
        }

        child.on('exit', (code) => {
          wb.close();
          process.exit(code ?? 0);
        });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        wb.close();
        process.exit(1);
      }
    });

  session
    .command('status <sessionId>')
    .description('Show the recorded status of one session')
    .action((sessionId) => {
      const found = findSession(sessionId);
      if (!found) {
        ui.log.error(`Session ${sessionId} not found.`);
        process.exit(1);
      }
      const { dir, record } = found;
      const promptPath = path.join(dir, 'prompt.md');

      const componentSources = [
        ...record.user_preferences,
        ...record.agent_preferences,
        ...record.task_components,
      ];

      const fields = [
        `Session id:     ${record.session_id}`,
        `State:          ${record.state}`,
        `Agent:          ${record.agent}`,
        `REQ sources:    ${record.req_sources.join(', ') || 'none'}`,
        `Components:     ${componentSources.join(', ') || 'none'}`,
        `Worktree:       ${record.worktree.branch}`,
        `Runtime:        ${record.runtime.profile} (${record.runtime.mode})`,
        `Port:           ${record.port}`,
        `Preview:        ${record.preview.enabled ? (record.preview.target ?? 'enabled') : 'disabled'}`,
        `Record path:    ${dir}`,
        `Prompt path:    ${promptPath}`,
        `Last update:    ${record.updated_at}`,
      ];

      if (record.state === 'draft') {
        fields.push('Status:         created, not started — run `workbench session start ' + sessionId + '`');
      } else {
        fields.push(`Status:         running${record.runtime_state?.pid ? ` (pid ${record.runtime_state.pid})` : ''}`);
      }

      ui.note(fields.join('\n'), `Session ${sessionId}`);
    });
}
