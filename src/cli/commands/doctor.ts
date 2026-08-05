/**
 * CLI: workbench doctor — Environment diagnostics and health checks.
 *
 * Checks:
 *   - Required tools (docker, git, agents)
 *   - Configured credentials
 *   - Runtime backends availability
 *   - Active task health (with --tasks flag)
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { Command } from 'commander';
import { resolveGlobalConfigPath } from '../../config.js';
import { createWorkbench } from '../context.js';
import { listAvailableBackends } from '../../runtime/backends.js';
import { HealthChecker, formatHealthReport } from '../../runtime/health.js';
import * as ui from '../ui.js';

interface ToolCheck {
  name: string;
  command: string;
  args?: string[];
  required?: boolean;
}

const CHECKS: ToolCheck[] = [
  { name: 'node', command: 'node', args: ['-v'], required: true },
  { name: 'npm', command: 'npm', args: ['-v'], required: true },
  { name: 'git', command: 'git', args: ['--version'], required: true },
  { name: 'docker', command: 'docker', args: ['--version'], required: true },
  { name: 'claude', command: 'claude', args: ['--version'] },
  { name: 'codex', command: 'codex', args: ['--version'] },
  { name: 'copilot', command: 'copilot', args: ['--version'] },
  { name: 'devcontainer', command: 'devcontainer', args: ['--version'] },
];

const CREDENTIAL_CHECKS = [
  { name: 'ANTHROPIC_API_KEY', description: 'Claude agent' },
  { name: 'OPENAI_API_KEY', description: 'Codex agent' },
  { name: 'GITHUB_TOKEN', description: 'Copilot agent' },
  { name: 'WORKBENCH_COOLIFY_TOKEN', description: 'Coolify previews' },
  { name: 'WORKBENCH_NETLIFY_TOKEN', description: 'Netlify previews' },
  { name: 'WORKBENCH_CLOUDFLARE_API_TOKEN', description: 'Cloudflare previews' },
];

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Show tooling, credentials, and task health status')
    .option('--tasks', 'Include active task health checks')
    .option('--verbose', 'Show detailed output')
    .action(async (opts) => {
      ui.intro('System diagnostics');

      let errors = 0;
      let warnings = 0;

      type Row = { name: string; ok: boolean; detail: string; required: boolean };

      const rows = await ui.spin('Running health checks', async () => {
        const out: Row[] = [];
        for (const check of CHECKS) {
          const result = runCheck(check.command, check.args ?? ['--version']);
          out.push({ name: check.name, ok: result.ok, detail: result.detail, required: Boolean(check.required) });
        }
        for (const backend of listAvailableBackends()) {
          out.push({
            name: `runtime:${backend.name}`,
            ok: backend.available,
            detail: backend.available ? 'Available' : 'Not available',
            required: false,
          });
        }
        const configPath = resolveGlobalConfigPath();
        out.push({ name: 'global config', ok: fs.existsSync(configPath), detail: configPath, required: false });
        for (const cred of CREDENTIAL_CHECKS) {
          const value = process.env[cred.name];
          out.push({
            name: cred.name,
            ok: Boolean(value),
            detail: value ? `Set (${value.length > 8 ? `${value.slice(0, 4)}...${value.slice(-4)}` : '****'})` : `Not set - ${cred.description}`,
            required: false,
          });
        }
        return out;
      });

      for (const r of rows) {
        const line = `${r.name.padEnd(28)} ${r.detail}`;
        if (r.ok) {
          ui.log.success(line);
        } else if (r.required) {
          ui.log.error(line);
          errors++;
        } else {
          ui.log.warn(line);
          warnings++;
        }
      }

      const wb = createWorkbench();
      try {
        ui.note(
          [
            `Workspace:       ${wb.config.workspace.name} (${wb.config.workspace.id})`,
            `Runtime mode:    ${wb.config.runtime.mode}`,
            `Default preview: ${wb.config.preview.default}`,
            `Memory backend:  ${process.env.WORKBENCH_MEMORY_BACKEND ?? 'file'}`,
            `Sandbox backend: ${process.env.WORKBENCH_SANDBOX_BACKEND ?? 'docker'}`,
          ].join('\n'),
          'Configuration',
        );

        if (opts.tasks) {
          const reports = await ui.spin('Checking active task health', async () => {
            const healthChecker = new HealthChecker(wb.orchestrator, wb.portAllocator);
            return healthChecker.checkAllTasks();
          });
          if (reports.length === 0) {
            ui.log.info('No active tasks.');
          } else {
            for (const report of reports) {
              ui.note(formatHealthReport(report), 'Task health');
              errors += report.discrepancies.length;
            }
          }
        }

        if (errors > 0) {
          ui.log.error(`${errors} error(s), ${warnings} warning(s) — fix errors before using Workbench.`);
        } else if (warnings > 0) {
          ui.log.warn(`No errors, ${warnings} warning(s) — Workbench is ready with limited functionality.`);
        } else {
          ui.log.success('All checks passed — Workbench is fully operational.');
        }

        ui.outro(
          'Diagnostics complete.',
          [
            'workbench init memory     — Configure memory backend',
            'workbench init agent      — Configure agent credentials',
            'workbench init sandboxing — Configure runtime sandbox',
            'workbench init deployment — Configure preview providers',
          ].join('\n'),
        );
      } finally {
        wb.close();
      }
    });
}

function runCheck(command: string, args: string[]): { ok: boolean; detail: string } {
  try {
    const out = execFileSync(command, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).toString().trim();
    const detail = out.split('\n')[0] ?? 'available';
    return { ok: true, detail };
  } catch {
    return { ok: false, detail: 'not available in PATH' };
  }
}
