/**
 * Cloudflare adapter — Edge/Workers preview lane.
 * Implements LLD-3 CloudflareAdapter.
 *
 * Credentials: WORKBENCH_CLOUDFLARE_API_TOKEN, WORKBENCH_CLOUDFLARE_ACCOUNT_ID from ~/.workbench.
 */

import type { DeploymentProvider } from './types.js';
import type {
  PreviewInput,
  PreviewHandle,
  PreviewStatus,
} from '../types.js';

export class CloudflareProvider implements DeploymentProvider {
  readonly name = 'cloudflare' as const;
  readonly kind = 'edge' as const;

  /** Project name → built into the handle's id-tag so getStatus/destroy can reach it. */
  private projectName(workspaceId: string, taskId: string): string {
    return `wb-${workspaceId}-${taskId}`.slice(0, 63).toLowerCase();
  }

  private get token(): string {
    const t = process.env.WORKBENCH_CLOUDFLARE_API_TOKEN;
    if (!t) throw new Error('WORKBENCH_CLOUDFLARE_API_TOKEN not set. See ~/.workbench credentials setup.');
    return t;
  }

  private get accountId(): string {
    const a = process.env.WORKBENCH_CLOUDFLARE_ACCOUNT_ID;
    if (!a) throw new Error('WORKBENCH_CLOUDFLARE_ACCOUNT_ID not set. See ~/.workbench credentials setup.');
    return a;
  }

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `https://api.cloudflare.com/client/v4${path}`;
    const resp = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Cloudflare API ${method} ${path} failed (${resp.status}): ${text}`);
    }

    const json = await resp.json() as { result: T };
    return json.result;
  }

  async deployPreview(input: PreviewInput): Promise<PreviewHandle> {
    const projectName = this.projectName(input.workspaceId, input.taskId);

    const deployment = await this.api<CfDeployment>(
      'POST',
      `/accounts/${this.accountId}/pages/projects/${projectName}/deployments`,
      { branch: input.branch },
    );

    return {
      // Encode project + deployment in id so getStatus/destroy can route correctly
      id: `${projectName}/${deployment.id}`,
      provider: 'cloudflare',
      url: deployment.url,
      status: 'building',
      createdAt: new Date().toISOString(),
    };
  }

  async getStatus(handle: PreviewHandle): Promise<PreviewStatus> {
    const { project, deployment } = this.parseHandleId(handle.id);
    try {
      const dep = await this.api<CfDeployment>(
        'GET',
        `/accounts/${this.accountId}/pages/projects/${project}/deployments/${deployment}`,
      );
      return mapCfStage(dep.latest_stage?.name ?? '');
    } catch {
      return 'failed';
    }
  }

  async attachCustomDomain(handle: PreviewHandle, domain: string): Promise<void> {
    const { project } = this.parseHandleId(handle.id);
    await this.api(
      'POST',
      `/accounts/${this.accountId}/pages/projects/${project}/domains`,
      { name: domain },
    );
  }

  async destroy(handle: PreviewHandle): Promise<void> {
    const { project, deployment } = this.parseHandleId(handle.id);
    await this.api(
      'DELETE',
      `/accounts/${this.accountId}/pages/projects/${project}/deployments/${deployment}`,
    );
  }

  private parseHandleId(id: string): { project: string; deployment: string } {
    const slash = id.indexOf('/');
    if (slash === -1) {
      // Legacy id without project prefix; cannot route safely
      return { project: 'wb-preview', deployment: id };
    }
    return { project: id.slice(0, slash), deployment: id.slice(slash + 1) };
  }
}

interface CfDeployment {
  id: string;
  url: string;
  latest_stage?: { name: string };
}

function mapCfStage(stage: string): PreviewStatus {
  switch (stage) {
    case 'queued':
    case 'build': return 'building';
    case 'deploy': return 'deploying';
    case 'success': return 'ready';
    default: return 'failed';
  }
}
