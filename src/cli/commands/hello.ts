/**
 * CLI: workbench hello — Banner + environment check.
 */

import type { Command } from 'commander';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { resolveGlobalConfigPath } from '../../config.js';
import * as ui from '../ui.js';

export function registerHelloCommand(program: Command): void {
  program
    .command('hello')
    .description('Show the Workbench banner and environment check')
    .action(() => {
      ui.intro('AI-first sandboxed agentic development.');

      const rows = [
        `node:        ${process.version}`,
        `git:         ${probe('git --version')}`,
        `docker:      ${probe('docker --version')}`,
        `compose:     ${probe('docker compose version')}`,
        `claude:      ${probe('claude --version')}`,
        `codex:       ${probe('codex --version')}`,
      ];

      const configPath = resolveGlobalConfigPath();
      const configExists = fs.existsSync(configPath);
      rows.push(`config:      ${configExists ? `found at ${configPath}` : 'missing — run workbench init'}`);

      if (configExists) {
        const flags: string[] = [];
        if (process.env.WORKBENCH_COOLIFY_URL) flags.push('coolify');
        if (process.env.WORKBENCH_NETLIFY_TOKEN) flags.push('netlify');
        if (process.env.WORKBENCH_CLOUDFLARE_API_TOKEN) flags.push('cloudflare');
        rows.push(`providers:   ${flags.length > 0 ? flags.join(', ') : 'none configured'}`);
      }

      ui.note(rows.join('\n'), 'Environment check');

      const next = fs.existsSync('workbench.yaml')
        ? 'workbench task create <name>\nworkbench status'
        : 'workbench init             # initialize this directory';
      ui.outro('Ready.', next);
    });
}

function probe(cmd: string): string {
  try {
    const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim();
    return out.split('\n')[0] || 'ok';
  } catch {
    return 'not installed';
  }
}
