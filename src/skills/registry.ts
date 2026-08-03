/**
 * SkillsRegistry + MetadataService — Skill/MCP lifecycle with scope promotion.
 * Implements LLD-2 MetadataService and LLD-4 skills/MCP registry.
 * File-first: skills stored as YAML files in `.workbench/skills/<scope>/<scope_id>/`.
 *
 * Provider symlinks (LLD-4):
 *   When a skill specifies a provider and an entrypoint file/dir exists,
 *   we symlink the entrypoint into the provider's commands/skills directory.
 *
 *   - claude  → ~/.claude/commands/<id>
 *   - codex   → ~/.codex/skills/<id>
 *   - copilot → ~/.config/github-copilot/commands/<id>  (best-effort; spike G3)
 */

import path from 'node:path';
import fs from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type {
  Scope,
  ScopeContext,
  SkillManifest,
  McpServerManifest,
  ResolvedManifest,
} from '../types.js';
import { resolveWorkbenchDir } from '../config.js';

const PROVIDER_DIRS: Record<string, string> = {
  claude: path.join(process.env.HOME ?? '~', '.claude', 'commands'),
  codex: path.join(process.env.HOME ?? '~', '.codex', 'skills'),
  copilot: path.join(process.env.HOME ?? '~', '.config', 'github-copilot', 'commands'),
};

interface StoredSkill extends SkillManifest {
  scope: Scope;
  scopeId: string;
  provenance?: string;
  createdAt: string;
  updatedAt: string;
}

interface StoredMcp extends McpServerManifest {
  scope: Scope;
  scopeId: string;
  createdAt: string;
  updatedAt: string;
}

export class SkillsRegistry {
  constructor() {}

  private resolveSkillsDir(): string {
    return path.join(resolveWorkbenchDir(), 'skills');
  }

  private resolveMcpDir(): string {
    return path.join(resolveWorkbenchDir(), 'mcp');
  }

  private skillPath(scope: Scope, scopeId: string, skillId: string): string {
    return path.join(this.resolveSkillsDir(), scope, scopeId, `${skillId}.yaml`);
  }

  private mcpPath(scope: Scope, scopeId: string, mcpId: string): string {
    return path.join(this.resolveMcpDir(), scope, scopeId, `${mcpId}.yaml`);
  }

  private now(): string {
    return new Date().toISOString();
  }

  // ------- Skills -------

  installSkill(scope: Scope, scopeId: string, manifest: SkillManifest, opts?: { symlink?: boolean }): { symlinkedTo?: string } {
    const now = this.now();
    const filePath = this.skillPath(scope, scopeId, manifest.id);
    const existing = this.readSkillFile(filePath);

    const stored: StoredSkill = {
      ...manifest,
      scope,
      scopeId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      provenance: existing?.provenance,
    };

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, stringifyYaml(stored, { indent: 2 }), 'utf-8');

    let symlinkedTo: string | undefined;
    if ((opts?.symlink ?? true) && manifest.provider && manifest.entrypoint) {
      symlinkedTo = this.symlinkSkillToProvider(manifest);
    }

    return { symlinkedTo };
  }

  private readSkillFile(filePath: string): StoredSkill | null {
    if (!fs.existsSync(filePath)) return null;
    try {
      return parseYaml(fs.readFileSync(filePath, 'utf-8')) as StoredSkill;
    } catch {
      return null;
    }
  }

  private symlinkSkillToProvider(manifest: SkillManifest): string | undefined {
    if (!manifest.provider || !manifest.entrypoint) return undefined;

    const providerDir = PROVIDER_DIRS[manifest.provider];
    if (!providerDir) return undefined;

    const entrypoint = path.resolve(manifest.entrypoint);
    if (!fs.existsSync(entrypoint)) {
      process.stderr.write(`warning: skill "${manifest.id}" entrypoint ${entrypoint} not found; skipping symlink\n`);
      return undefined;
    }

    const linkPath = path.join(providerDir, manifest.id);
    try {
      if (!fs.existsSync(providerDir)) fs.mkdirSync(providerDir, { recursive: true });
      try {
        const stat = fs.lstatSync(linkPath);
        if (stat) fs.rmSync(linkPath, { force: true, recursive: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      fs.symlinkSync(entrypoint, linkPath);
      return linkPath;
    } catch (err) {
      process.stderr.write(`warning: failed to symlink skill to ${linkPath}: ${err instanceof Error ? err.message : err}\n`);
      return undefined;
    }
  }

  private unsymlinkSkill(manifest: { id: string; provider?: string | null }): void {
    if (!manifest.provider) return;
    const providerDir = PROVIDER_DIRS[manifest.provider];
    if (!providerDir) return;
    const linkPath = path.join(providerDir, manifest.id);
    try {
      if (fs.existsSync(linkPath)) fs.rmSync(linkPath, { force: true, recursive: true });
    } catch { /* ignore */ }
  }

  resolveSkill(id: string, ctx: ScopeContext): ResolvedManifest | null {
    const scopes: [Scope, string][] = [];
    if (ctx.taskId) scopes.push(['task', ctx.taskId]);
    if (ctx.sessionId) scopes.push(['session', ctx.sessionId]);
    if (ctx.workspaceId) scopes.push(['workspace', ctx.workspaceId]);
    scopes.push(['global', 'global']);

    for (const [scope, scopeId] of scopes) {
      const filePath = this.skillPath(scope, scopeId, id);
      const stored = this.readSkillFile(filePath);

      if (stored) {
        return {
          id: stored.id,
          kind: 'skill',
          scope: stored.scope,
          scopeId: stored.scopeId,
          manifest: {
            name: stored.name,
            description: stored.description,
            version: stored.version,
            provider: stored.provider,
            entrypoint: stored.entrypoint,
            config: stored.config,
          },
          provenance: stored.provenance,
        };
      }
    }

    return null;
  }

  listSkills(scope?: Scope, scopeId?: string): SkillManifest[] {
    const results: SkillManifest[] = [];
    const skillsDir = this.resolveSkillsDir();

    if (!fs.existsSync(skillsDir)) return results;

    const scopesToScan: [Scope, string][] = [];
    if (scope && scopeId) {
      scopesToScan.push([scope, scopeId]);
    } else if (scope) {
      const scopeDir = path.join(skillsDir, scope);
      if (fs.existsSync(scopeDir)) {
        for (const sid of fs.readdirSync(scopeDir)) {
          if (fs.statSync(path.join(scopeDir, sid)).isDirectory()) {
            scopesToScan.push([scope, sid]);
          }
        }
      }
    } else {
      for (const s of ['global', 'workspace', 'session', 'task'] as Scope[]) {
        const scopeDir = path.join(skillsDir, s);
        if (fs.existsSync(scopeDir)) {
          for (const sid of fs.readdirSync(scopeDir)) {
            if (fs.statSync(path.join(scopeDir, sid)).isDirectory()) {
              scopesToScan.push([s, sid]);
            }
          }
        }
      }
    }

    for (const [s, sid] of scopesToScan) {
      const dir = path.join(skillsDir, s, sid);
      if (!fs.existsSync(dir)) continue;

      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.yaml')) continue;
        const stored = this.readSkillFile(path.join(dir, file));
        if (stored) {
          results.push({
            id: stored.id,
            name: stored.name,
            description: stored.description ?? '',
            version: stored.version,
            provider: stored.provider,
            entrypoint: stored.entrypoint,
            config: stored.config,
          });
        }
      }
    }

    return results.sort((a, b) => a.name.localeCompare(b.name));
  }

  promoteSkill(id: string, fromScope: Scope, fromScopeId: string, toScope: Scope, toScopeId: string): void {
    const fromPath = this.skillPath(fromScope, fromScopeId, id);
    const stored = this.readSkillFile(fromPath);

    if (!stored) throw new Error(`Skill ${id} not found at ${fromScope}/${fromScopeId}`);

    const now = this.now();
    const promoted: StoredSkill = {
      ...stored,
      scope: toScope,
      scopeId: toScopeId,
      provenance: `promoted:${fromScope}/${fromScopeId}`,
      createdAt: now,
      updatedAt: now,
    };

    const toPath = this.skillPath(toScope, toScopeId, id);
    fs.mkdirSync(path.dirname(toPath), { recursive: true });
    fs.writeFileSync(toPath, stringifyYaml(promoted, { indent: 2 }), 'utf-8');
  }

  removeSkill(id: string, scope: Scope, scopeId: string): boolean {
    const filePath = this.skillPath(scope, scopeId, id);
    const stored = this.readSkillFile(filePath);
    if (!stored) return false;

    fs.rmSync(filePath, { force: true });

    // Check if skill exists in any other scope before removing symlink
    const remaining = this.listSkills().some(s => s.id === id);
    if (!remaining) {
      this.unsymlinkSkill({ id, provider: stored.provider });
    }

    return true;
  }

  // ------- MCP Servers -------

  private readMcpFile(filePath: string): StoredMcp | null {
    if (!fs.existsSync(filePath)) return null;
    try {
      return parseYaml(fs.readFileSync(filePath, 'utf-8')) as StoredMcp;
    } catch {
      return null;
    }
  }

  installMcp(scope: Scope, scopeId: string, manifest: McpServerManifest): void {
    const now = this.now();
    const filePath = this.mcpPath(scope, scopeId, manifest.id);
    const existing = this.readMcpFile(filePath);

    const stored: StoredMcp = {
      ...manifest,
      scope,
      scopeId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, stringifyYaml(stored, { indent: 2 }), 'utf-8');
  }

  listMcp(scope?: Scope, scopeId?: string): McpServerManifest[] {
    const results: McpServerManifest[] = [];
    const mcpDir = this.resolveMcpDir();

    if (!fs.existsSync(mcpDir)) return results;

    const scopesToScan: [Scope, string][] = [];
    if (scope && scopeId) {
      scopesToScan.push([scope, scopeId]);
    } else if (scope) {
      const scopeDir = path.join(mcpDir, scope);
      if (fs.existsSync(scopeDir)) {
        for (const sid of fs.readdirSync(scopeDir)) {
          if (fs.statSync(path.join(scopeDir, sid)).isDirectory()) {
            scopesToScan.push([scope, sid]);
          }
        }
      }
    } else {
      for (const s of ['global', 'workspace', 'session', 'task'] as Scope[]) {
        const scopeDir = path.join(mcpDir, s);
        if (fs.existsSync(scopeDir)) {
          for (const sid of fs.readdirSync(scopeDir)) {
            if (fs.statSync(path.join(scopeDir, sid)).isDirectory()) {
              scopesToScan.push([s, sid]);
            }
          }
        }
      }
    }

    for (const [s, sid] of scopesToScan) {
      const dir = path.join(mcpDir, s, sid);
      if (!fs.existsSync(dir)) continue;

      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.yaml')) continue;
        const stored = this.readMcpFile(path.join(dir, file));
        if (stored) {
          results.push({
            id: stored.id,
            name: stored.name,
            description: stored.description ?? '',
            transport: stored.transport,
            command: stored.command,
            args: stored.args,
            url: stored.url,
            config: stored.config,
          });
        }
      }
    }

    return results.sort((a, b) => a.name.localeCompare(b.name));
  }

  removeMcp(id: string, scope: Scope, scopeId: string): boolean {
    const filePath = this.mcpPath(scope, scopeId, id);
    if (!fs.existsSync(filePath)) return false;
    fs.rmSync(filePath, { force: true });
    return true;
  }
}
