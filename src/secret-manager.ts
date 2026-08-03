/**
 * SecretManager + SecretPolicy — Scoped, audited, ephemeral secret injection.
 * Implements LLD-5.1.
 * File-first: secrets stored as encrypted files in `.workbench/secrets/`, audit log in `audit.jsonl`.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  Scope,
  ScopeContext,
  TaskSpec,
  RuntimeProbe,
  SecretPolicyVerdict,
  SecretAuditEntry,
  SecretMeta,
  ResolvedSecretSet,
  WorkbenchConfig,
} from './types.js';
import { resolveSecretsDir, resolveAuditLog } from './config.js';
import { appendJsonLine, uuid, now } from './stores/file-utils.js';

function getEncryptionKey(): Buffer {
  const envKey = process.env.WORKBENCH_SECRET_KEY;
  if (envKey) {
    return crypto.scryptSync(envKey, 'workbench-salt', 32);
  }
  const fallback = `workbench-${process.env.USER ?? 'default'}-${process.env.HOME ?? '/tmp'}`;
  return crypto.scryptSync(fallback, 'workbench-salt', 32);
}

interface StoredSecret {
  id: string;
  scopeLevel: Scope;
  scopeId: string;
  key: string;
  encryptedValue: string; // base64 encoded
  createdAt: string;
  updatedAt: string;
  rotatedAt?: string;
}

interface AuditEvent {
  id: string;
  event: 'secret_audit';
  ts: string;
  action: string;
  scope: string;
  key: string;
  taskId: string;
  provider: string;
  runtimeMode: string;
  verdict: string;
}

export class SecretManager {
  private encKey: Buffer;

  constructor(private config: WorkbenchConfig) {
    this.encKey = getEncryptionKey();
  }

  private secretPath(scope: Scope, scopeId: string, key: string): string {
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(resolveSecretsDir(), scope, scopeId, `${safeKey}.enc`);
  }

  private readSecretFile(filePath: string): StoredSecret | null {
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as StoredSecret;
    } catch {
      return null;
    }
  }

  private writeSecretFile(filePath: string, stored: StoredSecret): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(stored), { mode: 0o600 });
  }

  set(scope: Scope, scopeId: string, key: string, value: string, meta?: SecretMeta): void {
    const encrypted = this.encrypt(value);
    const timestamp = now();
    const filePath = this.secretPath(scope, scopeId, key);
    const existing = this.readSecretFile(filePath);

    const stored: StoredSecret = {
      id: existing?.id ?? uuid(),
      scopeLevel: scope,
      scopeId,
      key,
      encryptedValue: encrypted.toString('base64'),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      rotatedAt: meta?.rotatedAt ?? existing?.rotatedAt,
    };

    this.writeSecretFile(filePath, stored);
    this.audit('rotate', scope, key, '', '', '', existing ? 'updated' : 'created');
  }

  resolve(ctx: ScopeContext, allowlist: string[], provider: string): ResolvedSecretSet {
    const secrets = new Map<string, string>();
    const providerAllowlist = this.config.secrets.providerAllowlists[provider];

    for (const key of allowlist) {
      if (providerAllowlist && !providerAllowlist.includes(key)) {
        this.audit('resolve', 'global', key, ctx.taskId ?? '', provider, '', 'denied:provider_allowlist');
        continue;
      }

      const scopes: [Scope, string][] = [];
      if (ctx.taskId) scopes.push(['task', ctx.taskId]);
      if (ctx.sessionId) scopes.push(['session', ctx.sessionId]);
      if (ctx.workspaceId) scopes.push(['workspace', ctx.workspaceId]);
      scopes.push(['global', 'global']);

      let found = false;
      for (const [scope, scopeId] of scopes) {
        const filePath = this.secretPath(scope, scopeId, key);
        const stored = this.readSecretFile(filePath);

        if (stored) {
          const decrypted = this.decrypt(Buffer.from(stored.encryptedValue, 'base64'));
          secrets.set(key, decrypted);
          this.audit('resolve', scope, key, ctx.taskId ?? '', provider, '', 'allowed');
          found = true;
          break;
        }
      }

      if (!found) {
        this.audit('resolve', 'global', key, ctx.taskId ?? '', provider, '', 'not_found');
      }
    }

    return {
      secrets,
      scope: 'task',
      taskId: ctx.taskId ?? '',
    };
  }

  rotate(scope: Scope, scopeId: string, key: string, newValue: string): void {
    const filePath = this.secretPath(scope, scopeId, key);
    const existing = this.readSecretFile(filePath);
    if (!existing) return;

    const encrypted = this.encrypt(newValue);
    const timestamp = now();

    existing.encryptedValue = encrypted.toString('base64');
    existing.updatedAt = timestamp;
    existing.rotatedAt = timestamp;

    this.writeSecretFile(filePath, existing);
    this.audit('rotate', scope, key, '', '', '', 'rotated');
  }

  revoke(key: string): void {
    const secretsDir = resolveSecretsDir();
    if (!fs.existsSync(secretsDir)) return;

    for (const scope of ['global', 'workspace', 'session', 'task'] as Scope[]) {
      const scopeDir = path.join(secretsDir, scope);
      if (!fs.existsSync(scopeDir)) continue;

      for (const scopeId of fs.readdirSync(scopeDir)) {
        const filePath = this.secretPath(scope, scopeId, key);
        if (fs.existsSync(filePath)) {
          fs.rmSync(filePath, { force: true });
        }
      }
    }

    this.audit('revoke', 'global', key, '', '', '', 'revoked');
  }

  auditLog(filter?: { key?: string; taskId?: string; action?: string }): SecretAuditEntry[] {
    const logPath = resolveAuditLog();
    if (!fs.existsSync(logPath)) return [];

    const results: SecretAuditEntry[] = [];
    const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);

    for (const line of lines) {
      try {
        const event = JSON.parse(line) as AuditEvent;
        if (event.event !== 'secret_audit') continue;

        if (filter?.key && event.key !== filter.key) continue;
        if (filter?.taskId && event.taskId !== filter.taskId) continue;
        if (filter?.action && event.action !== filter.action) continue;

        results.push({
          id: event.id,
          timestamp: event.ts,
          action: event.action as SecretAuditEntry['action'],
          scope: event.scope as SecretAuditEntry['scope'],
          key: event.key,
          taskId: event.taskId,
          provider: event.provider,
          runtimeMode: (event.runtimeMode || 'bare-host') as SecretAuditEntry['runtimeMode'],
          verdict: event.verdict,
        });
      } catch { /* skip malformed */ }
    }

    return results
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, 100);
  }

  private encrypt(plaintext: string): Buffer {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]);
  }

  private decrypt(data: Buffer): string {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ciphertext = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.encKey, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ciphertext) + decipher.final('utf8');
  }

  private audit(
    action: string, scope: string, key: string,
    taskId: string, provider: string, runtimeMode: string, verdict: string,
  ): void {
    appendJsonLine(resolveAuditLog(), {
      id: uuid(),
      event: 'secret_audit',
      ts: now(),
      action,
      scope,
      key,
      taskId,
      provider,
      runtimeMode,
      verdict,
    } satisfies AuditEvent);
  }
}

export class SecretPolicy {
  constructor(private config: WorkbenchConfig) {}

  evaluate(spec: TaskSpec, probe: RuntimeProbe): SecretPolicyVerdict {
    const reasons: string[] = [];
    const deniedKeys: string[] = [];
    let enforceable = true;
    let injectionMethod: SecretPolicyVerdict['injectionMethod'] = 'env-sealed';

    const provider = spec.aiAgentProvider ?? 'claude';
    const allowlist = this.config.secrets.providerAllowlists[provider];
    if (allowlist && spec.secrets) {
      for (const key of spec.secrets) {
        if (!allowlist.includes(key)) {
          deniedKeys.push(key);
          reasons.push(`Key "${key}" not allowed for provider "${provider}".`);
        }
      }
    }

    switch (probe.runtimeMode) {
      case 'daemon-managed':
        injectionMethod = 'env-sealed';
        reasons.push('M1 daemon-managed: secrets injected as sealed env vars.');
        break;

      case 'dev-managed':
        if (this.config.secrets.requireTmpfsInDevManaged) {
          injectionMethod = 'tmpfs-file';
          reasons.push('M2 dev-managed: secrets written to tmpfs-mounted file (0400 perms).');
        } else {
          injectionMethod = 'tmpfs-file';
          reasons.push('M2 dev-managed: tmpfs injection (requireTmpfs not enforced).');
        }
        break;

      case 'bare-host':
        enforceable = false;
        injectionMethod = 'unenforceable';
        reasons.push('M3 bare-host: no isolation boundary, secret injection refused.');
        break;
    }

    return { enforceable, injectionMethod, deniedKeys, reasons };
  }
}
