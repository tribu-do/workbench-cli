/**
 * CLI: workbench deploy — Preview deployment commands.
 * File-first: preview records stored in `.workbench/previews.jsonl`.
 */

import type { Command } from 'commander';
import { createWorkbench } from '../context.js';
import { readActivePreviews, appendPreviewEvent } from '../../stores/preview-store.js';
import * as ui from '../ui.js';
import type { DeploymentProviderName } from '../../types.js';

export function registerDeployCommand(program: Command): void {
  const deploy = program
    .command('deploy')
    .description('Manage preview deployments');

  deploy
    .command('preview <taskId>')
    .description('Deploy a preview for a task')
    .option('-p, --provider <provider>', 'Override default provider (coolify|netlify|cloudflare)')
    .option('--build-command <cmd>', 'Build command')
    .option('--output-dir <dir>', 'Output directory')
    .action(async (taskId, opts) => {
      const wb = createWorkbench();
      try {
        const task = wb.orchestrator.getTask(taskId);
        if (!task) {
          ui.log.error(`Task ${taskId} not found.`);
          process.exit(1);
        }

        const providerName = (opts.provider ?? wb.config.preview.default) as DeploymentProviderName;
        const provider = wb.getDeploymentProvider(providerName);
        const leases = wb.portAllocator.list({ sessionId: task.sessionId });

        const handle = await ui.spin(`Deploying preview via ${providerName}`, () =>
          provider.deployPreview({
            taskId: task.id,
            workspaceId: task.workspaceId,
            branch: task.branch,
            buildCommand: opts.buildCommand,
            outputDir: opts.outputDir,
            ports: leases,
          }),
        );

        appendPreviewEvent({
          event: 'create',
          taskId: task.id,
          workspaceId: task.workspaceId,
          provider: providerName,
          url: handle.url,
          status: handle.status,
          externalId: handle.id,
        });

        ui.log.success('Preview deployed.');
        ui.note(
          [`URL:      ${handle.url}`, `Status:   ${handle.status}`, `Provider: ${providerName}`].join('\n'),
          'Preview',
        );
      } catch (err) {
        ui.log.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      } finally {
        wb.close();
      }
    });

  deploy
    .command('status <taskId>')
    .description('Check preview deployment status (polls provider live)')
    .option('--no-poll', 'Skip live polling; show only stored state')
    .action(async (taskId, opts) => {
      const wb = createWorkbench();
      try {
        const previews = readActivePreviews(taskId)
          .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

        if (previews.length === 0) {
          console.log('No active previews for this task.');
          return;
        }

        for (const preview of previews) {
          let liveStatus = preview.status;

          if (opts.poll !== false) {
            try {
              const provider = wb.getDeploymentProvider(preview.provider as DeploymentProviderName);
              const status = await provider.getStatus({
                id: preview.externalId,
                provider: preview.provider as DeploymentProviderName,
                url: preview.url ?? '',
                status: preview.status as 'building',
                createdAt: preview.timestamp,
              });
              liveStatus = status;

              if (status !== preview.status) {
                appendPreviewEvent({
                  id: preview.id,
                  event: 'update',
                  taskId: preview.taskId,
                  workspaceId: preview.workspaceId,
                  provider: preview.provider,
                  url: preview.url,
                  status,
                  externalId: preview.externalId,
                });
              }
            } catch (err) {
              console.error(`  Warning: live poll failed for ${preview.provider}: ${err instanceof Error ? err.message : err}`);
            }
          }

          console.log(`Preview: ${preview.id}`);
          console.log(`  Provider: ${preview.provider}`);
          console.log(`  URL:      ${preview.url ?? 'pending'}`);
          console.log(`  Status:   ${liveStatus}${liveStatus !== preview.status ? ` (was ${preview.status})` : ''}`);
          console.log(`  Created:  ${preview.timestamp}`);
        }
      } finally {
        wb.close();
      }
    });

  deploy
    .command('destroy <taskId>')
    .description('Destroy preview deployments for a task')
    .action(async (taskId) => {
      const wb = createWorkbench();
      try {
        const previews = readActivePreviews(taskId);

        for (const preview of previews) {
          try {
            const provider = wb.getDeploymentProvider(preview.provider as DeploymentProviderName);
            await provider.destroy({
              id: preview.externalId,
              provider: preview.provider as DeploymentProviderName,
              url: preview.url ?? '',
              status: 'ready',
              createdAt: preview.timestamp,
            });
          } catch (err) {
            console.error(`Warning: failed to destroy ${preview.provider} preview: ${err instanceof Error ? err.message : err}`);
          }

          appendPreviewEvent({
            id: preview.id,
            event: 'destroy',
            taskId: preview.taskId,
            workspaceId: preview.workspaceId,
            provider: preview.provider,
            url: preview.url,
            status: 'destroyed',
            externalId: preview.externalId,
          });
        }

        console.log(`Destroyed ${previews.length} preview(s) for task ${taskId}.`);
      } finally {
        wb.close();
      }
    });
}
