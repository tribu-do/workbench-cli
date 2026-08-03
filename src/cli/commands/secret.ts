/**
 * CLI: workbench secret — Secret management commands.
 */

import type { Command } from 'commander';
import { createWorkbench } from '../context.js';
import * as ui from '../ui.js';
import type { Scope } from '../../types.js';

export function registerSecretCommand(program: Command): void {
  const secret = program
    .command('secret')
    .description('Manage secrets (deny-by-default, scoped, audited)');

  secret
    .command('set <key> [value]')
    .description('Store a secret at a scope')
    .option('-s, --scope <scope>', 'Scope (global|workspace|session|task)', 'global')
    .option('--scope-id <scopeId>', 'Scope ID', 'global')
    .action(async (key, value, opts) => {
      const wb = createWorkbench();
      try {
        let secretValue = value as string | undefined;
        if (!secretValue) {
          if (ui.mode() === 'non_interactive') {
            ui.log.error(`Missing value for secret "${key}". Pass it as an argument in non-interactive mode.`);
            process.exit(1);
          }
          secretValue = await ui.password({ message: `Value for "${key}"` });
        }
        wb.secretManager.set(opts.scope as Scope, opts.scopeId, key, secretValue);
        ui.log.success(`Secret "${key}" stored at ${opts.scope}/${opts.scopeId}.`);
      } finally {
        wb.close();
      }
    });

  secret
    .command('rotate <key> [newValue]')
    .description('Rotate a secret value')
    .option('-s, --scope <scope>', 'Scope', 'global')
    .option('--scope-id <scopeId>', 'Scope ID', 'global')
    .action(async (key, newValue, opts) => {
      const wb = createWorkbench();
      try {
        let value = newValue as string | undefined;
        if (!value) {
          if (ui.mode() === 'non_interactive') {
            ui.log.error(`Missing new value for secret "${key}". Pass it as an argument in non-interactive mode.`);
            process.exit(1);
          }
          value = await ui.password({ message: `New value for "${key}"` });
        }
        wb.secretManager.rotate(opts.scope as Scope, opts.scopeId, key, value);
        ui.log.success(`Secret "${key}" rotated at ${opts.scope}/${opts.scopeId}.`);
      } finally {
        wb.close();
      }
    });

  secret
    .command('revoke <key>')
    .description('Revoke a secret across all scopes')
    .action((key) => {
      const wb = createWorkbench();
      try {
        wb.secretManager.revoke(key);
        console.log(`Secret "${key}" revoked across all scopes.`);
      } finally {
        wb.close();
      }
    });

  secret
    .command('audit')
    .description('View secret audit log')
    .option('-k, --key <key>', 'Filter by key')
    .option('-t, --task-id <taskId>', 'Filter by task ID')
    .option('-a, --action <action>', 'Filter by action (resolve|inject|rotate|revoke)')
    .action((opts) => {
      const wb = createWorkbench();
      try {
        const entries = wb.secretManager.auditLog({
          key: opts.key,
          taskId: opts.taskId,
          action: opts.action,
        });

        if (entries.length === 0) {
          console.log('No audit entries found.');
          return;
        }

        console.log('Timestamp                    Action    Key                Verdict');
        console.log('─'.repeat(72));
        for (const e of entries) {
          const ts = e.timestamp.padEnd(28);
          const action = e.action.padEnd(9);
          const key = e.key.padEnd(18);
          console.log(`${ts} ${action} ${key} ${e.verdict}`);
        }
      } finally {
        wb.close();
      }
    });
}
