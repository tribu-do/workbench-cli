/**
 * CLI: workbench gc — Periodic garbage collection for ports and previews.
 * File-first: reads from previews.jsonl and task YAML files.
 *
 * Runs once by default. Pass --interval <ms> to loop (foreground daemon).
 */

import type { Command } from 'commander';
import { createWorkbench, type WorkbenchContext } from '../context.js';
import { readActivePreviews, appendPreviewEvent, type PreviewRecord } from '../../stores/preview-store.js';
import type { DeploymentProviderName } from '../../types.js';

export function registerGcCommand(program: Command): void {
  program
    .command('gc')
    .description('Run garbage collection (stale port leases + preview cleanup)')
    .option('--interval <seconds>', 'Run continuously every N seconds')
    .option('--once', 'Run a single GC pass and exit (default)')
    .action(async (opts) => {
      const wb = createWorkbench();

      const runOnce = async () => {
        const portsResult = await wb.portAllocator.reclaim();
        const previewsResult = await runPreviewGc(wb);

        const ts = new Date().toISOString();
        console.log(`[${ts}] gc.run`);
        console.log(`  ports: released=${portsResult.released} skipped=${portsResult.skipped}`);
        console.log(`  previews: destroyed=${previewsResult.destroyed} warned=${previewsResult.warned} skipped=${previewsResult.skipped}`);
      };

      if (opts.interval) {
        const ms = parseInt(opts.interval, 10) * 1000;
        if (isNaN(ms) || ms < 1000) {
          console.error('Invalid --interval. Must be >= 1 second.');
          process.exit(1);
        }
        console.log(`Running GC every ${opts.interval}s (Ctrl+C to stop)...`);
        try {
          while (true) {
            await runOnce();
            await new Promise(r => setTimeout(r, ms));
          }
        } finally {
          wb.close();
        }
      } else {
        try {
          await runOnce();
        } finally {
          wb.close();
        }
      }
    });
}

async function runPreviewGc(wb: WorkbenchContext): Promise<{ destroyed: number; warned: number; skipped: number }> {
  const gc = wb.config.preview.gc;
  const now = Date.now();
  let destroyed = 0;
  let warned = 0;
  let skipped = 0;

  const previews = readActivePreviews();

  for (const preview of previews) {
    const task = wb.orchestrator.getTask(preview.taskId);

    if (!task) {
      await tearDown(wb, preview);
      destroyed++;
      continue;
    }

    const taskUpdatedAge = now - new Date(task.updatedAt).getTime();

    let shouldDestroy = false;
    let reason = '';

    if (task.state === 'merged') {
      if (taskUpdatedAge > gc.afterMergeDelayMs) {
        shouldDestroy = true;
        reason = 'task merged';
      }
    } else if (task.state === 'aborted') {
      shouldDestroy = true;
      reason = 'task aborted';
    } else if (task.state === 'suspended') {
      if (taskUpdatedAge > gc.suspendTtlMs) {
        shouldDestroy = true;
        reason = 'task suspended past TTL';
      }
    } else if (task.state === 'running' || task.state === 'downgraded') {
      if (taskUpdatedAge > gc.idleTtlMs + gc.idleGracePeriodMs) {
        shouldDestroy = true;
        reason = 'task idle past TTL+grace';
      } else if (taskUpdatedAge > gc.idleTtlMs) {
        warned++;
        skipped++;
        continue;
      }
    }

    if (shouldDestroy) {
      await tearDown(wb, preview, reason);
      destroyed++;
    } else {
      skipped++;
    }
  }

  // Workspace cap enforcement
  const byWorkspace = new Map<string, PreviewRecord[]>();
  for (const p of previews) {
    if (!byWorkspace.has(p.workspaceId)) byWorkspace.set(p.workspaceId, []);
    byWorkspace.get(p.workspaceId)!.push(p);
  }
  for (const [, ws] of byWorkspace) {
    if (ws.length <= gc.maxActivePerWorkspace) continue;
    const sorted = [...ws].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const overflow = sorted.slice(0, ws.length - gc.maxActivePerWorkspace);
    for (const p of overflow) {
      await tearDown(wb, p, 'workspace cap exceeded');
      destroyed++;
    }
  }

  return { destroyed, warned, skipped };
}

async function tearDown(wb: WorkbenchContext, preview: PreviewRecord, _reason = ''): Promise<void> {
  try {
    const provider = wb.getDeploymentProvider(preview.provider as DeploymentProviderName);
    await provider.destroy({
      id: preview.externalId,
      provider: preview.provider as DeploymentProviderName,
      url: preview.url ?? '',
      status: 'ready',
      createdAt: preview.timestamp,
    });
  } catch {
    // Continue with cleanup even if provider call failed
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
