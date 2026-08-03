/**
 * CLI: workbench skill — Skill & MCP lifecycle commands.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Command } from 'commander';
import { createWorkbench } from '../context.js';
import type { Scope } from '../../types.js';

/** Skills bundled from @arabold/docs-mcp-server that get copied into agent worktrees */
const DOCS_MCP_SKILLS = ['docs-search', 'docs-manage', 'fetch-url'] as const;

export function registerSkillCommand(program: Command): void {
  const skill = program
    .command('skill')
    .description('Manage skills and MCP servers');

  skill
    .command('install <id> <name>')
    .description('Install a skill (symlinks to provider dir if --provider + --entrypoint given)')
    .option('-s, --scope <scope>', 'Scope (global|workspace|session|task)', 'global')
    .option('--scope-id <scopeId>', 'Scope ID', 'global')
    .option('-d, --description <desc>', 'Skill description', '')
    .option('-v, --version <version>', 'Version', '0.1.0')
    .option('--provider <provider>', 'Provider constraint (claude|codex|copilot)')
    .option('--entrypoint <entrypoint>', 'Entrypoint file or command')
    .option('--no-symlink', 'Do not symlink to provider dir')
    .action((id, name, opts) => {
      const wb = createWorkbench();
      try {
        const result = wb.skillsRegistry.installSkill(opts.scope as Scope, opts.scopeId, {
          id,
          name,
          description: opts.description,
          version: opts.version,
          provider: opts.provider,
          entrypoint: opts.entrypoint,
        }, { symlink: opts.symlink !== false });
        console.log(`Skill "${name}" (${id}) installed at ${opts.scope}/${opts.scopeId}.`);
        if (result.symlinkedTo) {
          console.log(`  Symlinked to ${result.symlinkedTo}`);
        }
      } finally {
        wb.close();
      }
    });

  skill
    .command('list')
    .description('List installed skills')
    .option('-s, --scope <scope>', 'Filter by scope')
    .option('--scope-id <scopeId>', 'Filter by scope ID')
    .action((opts) => {
      const wb = createWorkbench();
      try {
        const skills = wb.skillsRegistry.listSkills(opts.scope, opts.scopeId);

        if (skills.length === 0) {
          console.log('No skills installed.');
          return;
        }

        console.log('ID                   Name                 Version    Provider');
        console.log('─'.repeat(68));
        for (const s of skills) {
          console.log(`${s.id.padEnd(20)} ${s.name.padEnd(20)} ${s.version.padEnd(10)} ${s.provider ?? 'any'}`);
        }
      } finally {
        wb.close();
      }
    });

  skill
    .command('promote <id>')
    .description('Promote a skill to a higher scope')
    .option('--from-scope <scope>', 'Source scope', 'workspace')
    .option('--from-id <scopeId>', 'Source scope ID')
    .option('--to-scope <scope>', 'Target scope', 'global')
    .option('--to-id <scopeId>', 'Target scope ID', 'global')
    .action((id, opts) => {
      const wb = createWorkbench();
      try {
        wb.skillsRegistry.promoteSkill(
          id,
          opts.fromScope as Scope,
          opts.fromId ?? wb.config.workspace.id,
          opts.toScope as Scope,
          opts.toId,
        );
        console.log(`Skill ${id} promoted from ${opts.fromScope} to ${opts.toScope}.`);
      } finally {
        wb.close();
      }
    });

  skill
    .command('remove <id>')
    .description('Remove a skill')
    .option('-s, --scope <scope>', 'Scope', 'global')
    .option('--scope-id <scopeId>', 'Scope ID', 'global')
    .action((id, opts) => {
      const wb = createWorkbench();
      try {
        const removed = wb.skillsRegistry.removeSkill(id, opts.scope as Scope, opts.scopeId);
        if (removed) {
          console.log(`Skill ${id} removed.`);
        } else {
          console.log(`Skill ${id} not found at ${opts.scope}/${opts.scopeId}.`);
        }
      } finally {
        wb.close();
      }
    });

  /**
   * Install docs-mcp-server skills into a worktree (or cwd).
   * Copies SKILL.md files for docs-search, docs-manage, fetch-url
   * into <targetDir>/.claude/skills/<skill-name>/SKILL.md so agents
   * can invoke /docs-search, /docs-manage, /fetch-url natively.
   */
  skill
    .command('docs-install')
    .description('Copy docs-mcp-server skills (docs-search, docs-manage, fetch-url) into a worktree')
    .option('-t, --target <dir>', 'Target directory (defaults to cwd)')
    .option('--task-id <id>', 'Task ID to look up worktree path')
    .action((opts) => {
      const wb = createWorkbench();
      try {
        let targetDir = opts.target ?? process.cwd();

        // If task-id given, resolve its worktree path
        if (opts.taskId) {
          const task = wb.orchestrator.getTask(opts.taskId);
          if (!task) {
            console.error(`Task ${opts.taskId} not found.`);
            process.exit(1);
          }
          targetDir = (task.metadata.worktreePath as string | undefined) ?? process.cwd();
        }

        // Resolve the skills source from the installed npm package
        let skillsSourceDir: string | null = null;
        try {
          const pkgJson = execFileSync('npx', ['@arabold/docs-mcp-server@latest', '--version'], {
            stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
          });
          // Package available — find its skills/ dir via node resolution
          const resolved = execFileSync('node', ['-e',
            'console.log(require.resolve("@arabold/docs-mcp-server/package.json"))',
          ], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, env: process.env }).toString().trim();
          skillsSourceDir = path.join(path.dirname(resolved), 'skills');
          if (!fs.existsSync(skillsSourceDir)) skillsSourceDir = null;
          void pkgJson; // used only for availability check
        } catch { /* will fall back to embedded copies below */ }

        const destBase = path.join(targetDir, '.claude', 'skills');
        let installed = 0;
        let skipped = 0;

        for (const skillName of DOCS_MCP_SKILLS) {
          const destDir = path.join(destBase, skillName);
          const destFile = path.join(destDir, 'SKILL.md');

          // Don't overwrite existing installs unless source is available
          if (fs.existsSync(destFile) && !skillsSourceDir) {
            skipped++;
            continue;
          }

          fs.mkdirSync(destDir, { recursive: true });

          if (skillsSourceDir) {
            const srcFile = path.join(skillsSourceDir, skillName, 'SKILL.md');
            if (fs.existsSync(srcFile)) {
              fs.copyFileSync(srcFile, destFile);
              installed++;
              continue;
            }
          }

          // Fallback: write embedded stub pointing agents to the CLI
          const stub = embeddedSkillStub(skillName);
          if (stub && !fs.existsSync(destFile)) {
            fs.writeFileSync(destFile, stub);
            installed++;
          }
        }

        console.log(`Docs skills installed in ${destBase}`);
        console.log(`  Installed: ${installed}  Skipped (already present): ${skipped}`);
        for (const s of DOCS_MCP_SKILLS) {
          const exists = fs.existsSync(path.join(destBase, s, 'SKILL.md'));
          console.log(`  ${exists ? '✓' : '✗'} ${s}`);
        }
      } finally {
        wb.close();
      }
    });

  // ------- MCP -------

  const mcp = program
    .command('mcp')
    .description('Manage MCP servers');

  mcp
    .command('install <id> <name>')
    .description('Install an MCP server')
    .option('-s, --scope <scope>', 'Scope', 'global')
    .option('--scope-id <scopeId>', 'Scope ID', 'global')
    .option('-d, --description <desc>', 'Description', '')
    .option('-t, --transport <transport>', 'Transport (stdio|sse|streamable-http)', 'stdio')
    .option('-c, --command <command>', 'Command to start the server')
    .option('--args <args...>', 'Arguments')
    .option('--url <url>', 'URL for SSE/HTTP transport')
    .action((id, name, opts) => {
      const wb = createWorkbench();
      try {
        wb.skillsRegistry.installMcp(opts.scope as Scope, opts.scopeId, {
          id,
          name,
          description: opts.description,
          transport: opts.transport,
          command: opts.command,
          args: opts.args,
          url: opts.url,
        });
        console.log(`MCP server "${name}" (${id}) installed at ${opts.scope}/${opts.scopeId}.`);
      } finally {
        wb.close();
      }
    });

  mcp
    .command('list')
    .description('List installed MCP servers')
    .option('-s, --scope <scope>', 'Filter by scope')
    .option('--scope-id <scopeId>', 'Filter by scope ID')
    .action((opts) => {
      const wb = createWorkbench();
      try {
        const servers = wb.skillsRegistry.listMcp(opts.scope, opts.scopeId);

        if (servers.length === 0) {
          console.log('No MCP servers installed.');
          return;
        }

        console.log('ID                   Name                 Transport');
        console.log('─'.repeat(56));
        for (const s of servers) {
          console.log(`${s.id.padEnd(20)} ${s.name.padEnd(20)} ${s.transport}`);
        }
      } finally {
        wb.close();
      }
    });
}

// ─── Embedded skill stubs ────────────────────────────────────────────────────
// Minimal SKILL.md content used when the npm package's skills/ dir isn't
// resolvable. Agents can use these to understand the CLI surface.

function embeddedSkillStub(skillName: typeof DOCS_MCP_SKILLS[number]): string | null {
  const stubs: Record<typeof DOCS_MCP_SKILLS[number], string> = {
    'docs-search': `---
name: docs-search
description: >-
  Search and query the Workbench documentation index.
  Lists indexed libraries, searches documentation content,
  and resolves library versions.
compatibility: Requires Node.js 22+ and npx
---

# Docs Search

Search the local documentation index for library docs.

## Commands

\`\`\`bash
# List indexed libraries
npx @arabold/docs-mcp-server@latest list --output yaml

# Search a library
npx @arabold/docs-mcp-server@latest search <library> "<query>" --version <ver> --output yaml

# Find best matching version
npx @arabold/docs-mcp-server@latest find-version <library> --version "18.x"
\`\`\`

If a library is not indexed, use the **docs-manage** skill to scrape it first.
`,
    'docs-manage': `---
name: docs-manage
description: >-
  Manage the Workbench documentation index. Scrape docs from URLs,
  refresh existing entries, and remove stale libraries.
compatibility: Requires Node.js 22+ and npx
---

# Docs Manage

Index, refresh, and remove library documentation.

## Commands

\`\`\`bash
# Index documentation
npx @arabold/docs-mcp-server@latest scrape <library> <url> --version <ver> --scrape-mode fetch

# Refresh existing index
npx @arabold/docs-mcp-server@latest refresh <library> --version <ver>

# Remove a library
npx @arabold/docs-mcp-server@latest remove <library>
\`\`\`
`,
    'fetch-url': `---
name: fetch-url
description: >-
  Fetch a single URL and convert its content to Markdown.
  Does not index. Use for one-shot reads before deciding to index.
compatibility: Requires Node.js 22+ and npx
---

# Fetch URL

Fetch a URL and get its content as Markdown.

## Command

\`\`\`bash
npx @arabold/docs-mcp-server@latest fetch-url <url> [--scrape-mode fetch|playwright]
\`\`\`
`,
  };
  return stubs[skillName] ?? null;
}
