/**
 * CoolifyPreview adapter — Default full-stack preview provider.
 * Implements LLD-3 CoolifyPreview.
 *
 * Coolify API docs: https://coolify.io/docs/api-reference/authorization
 * Credentials loaded from ~/.workbench (WORKBENCH_COOLIFY_URL, WORKBENCH_COOLIFY_TOKEN).
 */

import type { DeploymentProvider } from './types.js';
import type {
  PreviewInput,
  PreviewHandle,
  PreviewStatus,
} from '../types.js';

export class CoolifyPreviewProvider implements DeploymentProvider {
  readonly name = 'coolify' as const;
  readonly kind = 'full-stack' as const;

  private get baseUrl(): string {
    const url = process.env.WORKBENCH_COOLIFY_URL;
    if (!url) throw new Error('WORKBENCH_COOLIFY_URL not set. See ~/.workbench credentials setup.');
    return url.replace(/\/+$/, '');
  }

  private get token(): string {
    const token = process.env.WORKBENCH_COOLIFY_TOKEN;
    if (!token) throw new Error('WORKBENCH_COOLIFY_TOKEN not set. See ~/.workbench credentials setup.');
    return token;
  }

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}/api/v1${path}`;
    const resp = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Coolify API ${method} ${path} failed (${resp.status}): ${text}`);
    }

    return resp.json() as Promise<T>;
  }

  async deployPreview(input: PreviewInput): Promise<PreviewHandle> {
    const appName = `wb-${input.workspaceId}-${input.taskId}`.slice(0, 63).toLowerCase();

    // Build env vars from port leases
    const envVars: Record<string, string> = { ...input.envVars };
    if (input.ports) {
      for (const lease of input.ports) {
        envVars[`WORKBENCH_PORT_${lease.name.toUpperCase()}`] = String(lease.port);
      }
    }

    // Coolify requires a destination (server/project) UUID and source (git repo) info.
    // Pass through optional WORKBENCH_COOLIFY_* env knobs; sensible defaults otherwise.
    const projectUuid = process.env.WORKBENCH_COOLIFY_PROJECT_UUID;
    const serverUuid = process.env.WORKBENCH_COOLIFY_SERVER_UUID;
    const environmentName = process.env.WORKBENCH_COOLIFY_ENVIRONMENT_NAME ?? 'production';
    const gitRepository = process.env.WORKBENCH_COOLIFY_GIT_REPOSITORY ?? input.branch;

    const body: Record<string, unknown> = {
      name: appName,
      project_uuid: projectUuid,
      server_uuid: serverUuid,
      environment_name: environmentName,
      git_repository: gitRepository,
      git_branch: input.branch,
      build_pack: 'nixpacks',
      ports_exposes: input.ports?.[0]?.port ? String(input.ports[0].port) : '3000',
      instant_deploy: true,
    };
    if (input.buildCommand) body.build_command = input.buildCommand;
    if (input.outputDir) body.publish_directory = input.outputDir;

    // Apply env vars
    body.environment_variables = Object.entries(envVars).map(([key, value]) => ({ key, value }));

    const app = await this.api<CoolifyApp>('POST', '/applications/public', body);

    // If instant_deploy didn't trigger (older Coolify), explicitly deploy
    if (!app.fqdn) {
      try {
        await this.api('POST', `/applications/${app.uuid}/deploy`, {});
      } catch { /* ignore — likely already triggered */ }
    }

    const previewUrl = app.fqdn ?? `https://${appName}.${this.baseDomain()}`;

    return {
      id: app.uuid,
      provider: 'coolify',
      url: previewUrl,
      status: 'building',
      createdAt: new Date().toISOString(),
    };
  }

  async getStatus(handle: PreviewHandle): Promise<PreviewStatus> {
    try {
      const app = await this.api<CoolifyApp>('GET', `/applications/${handle.id}`);
      return mapCoolifyStatus(app.status ?? 'unknown');
    } catch {
      return 'failed';
    }
  }

  async attachCustomDomain(handle: PreviewHandle, domain: string): Promise<void> {
    await this.api('PATCH', `/applications/${handle.id}`, {
      fqdn: `https://${domain}`,
    });
  }

  async destroy(handle: PreviewHandle): Promise<void> {
    await this.api('DELETE', `/applications/${handle.id}`);
  }

  private baseDomain(): string {
    try {
      const url = new URL(this.baseUrl);
      return url.hostname;
    } catch {
      return 'preview.workbench.local';
    }
  }
}

// ------- Coolify API types (subset) -------

interface CoolifyApp {
  uuid: string;
  name: string;
  status?: string;
  fqdn?: string;
}

function mapCoolifyStatus(status: string): PreviewStatus {
  switch (status) {
    case 'building': return 'building';
    case 'deploying': return 'deploying';
    case 'running': return 'ready';
    case 'stopped':
    case 'exited': return 'destroyed';
    default: return 'failed';
  }
}
