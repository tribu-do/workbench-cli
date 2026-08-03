/**
 * Netlify adapter — Static/marketing preview lane.
 * Implements LLD-3 NetlifyAdapter.
 *
 * Credentials: WORKBENCH_NETLIFY_TOKEN, WORKBENCH_NETLIFY_SITE_ID from ~/.workbench.
 */

import type { DeploymentProvider } from './types.js';
import type {
  PreviewInput,
  PreviewHandle,
  PreviewStatus,
} from '../types.js';

export class NetlifyProvider implements DeploymentProvider {
  readonly name = 'netlify' as const;
  readonly kind = 'static' as const;

  private get token(): string {
    const t = process.env.WORKBENCH_NETLIFY_TOKEN;
    if (!t) throw new Error('WORKBENCH_NETLIFY_TOKEN not set. See ~/.workbench credentials setup.');
    return t;
  }

  private get siteId(): string {
    const s = process.env.WORKBENCH_NETLIFY_SITE_ID;
    if (!s) throw new Error('WORKBENCH_NETLIFY_SITE_ID not set. See ~/.workbench credentials setup.');
    return s;
  }

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `https://api.netlify.com/api/v1${path}`;
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
      throw new Error(`Netlify API ${method} ${path} failed (${resp.status}): ${text}`);
    }

    return resp.json() as Promise<T>;
  }

  async deployPreview(input: PreviewInput): Promise<PreviewHandle> {
    const deploy = await this.api<NetlifyDeploy>('POST', `/sites/${this.siteId}/deploys`, {
      branch: input.branch,
      title: `workbench-${input.taskId}`,
    });

    return {
      id: deploy.id,
      provider: 'netlify',
      url: deploy.deploy_ssl_url ?? deploy.deploy_url,
      status: 'building',
      createdAt: new Date().toISOString(),
    };
  }

  async getStatus(handle: PreviewHandle): Promise<PreviewStatus> {
    try {
      const deploy = await this.api<NetlifyDeploy>('GET', `/deploys/${handle.id}`);
      return mapNetlifyState(deploy.state);
    } catch {
      return 'failed';
    }
  }

  async attachCustomDomain(_handle: PreviewHandle, domain: string): Promise<void> {
    await this.api('POST', `/sites/${this.siteId}/dns`, { hostname: domain });
  }

  async destroy(handle: PreviewHandle): Promise<void> {
    await this.api('DELETE', `/deploys/${handle.id}`);
  }
}

interface NetlifyDeploy {
  id: string;
  state: string;
  deploy_url: string;
  deploy_ssl_url?: string;
}

function mapNetlifyState(state: string): PreviewStatus {
  switch (state) {
    case 'building':
    case 'enqueued': return 'building';
    case 'uploading':
    case 'processing': return 'deploying';
    case 'ready': return 'ready';
    default: return 'failed';
  }
}
