/**
 * CLI context — Wires up all Workbench services for CLI commands.
 * File-first: no SQLite database dependency.
 */

import { loadConfig, loadCredentials } from '../config.js';
import { Orchestrator } from '../orchestrator.js';
import { PolicyEngine } from '../policy-engine.js';
import { PortAllocator } from '../port-allocator.js';
import { SecretManager, SecretPolicy } from '../secret-manager.js';
import { SandboxBroker } from '../sandbox-broker.js';
import { MemoryService } from '../memory/service.js';
import { SkillsRegistry } from '../skills/registry.js';
import { SessionService } from '../sessions/service.js';
import { ClaudeProvider } from '../agents/claude.js';
import type { AgentProvider } from '../agents/types.js';
import { CoolifyPreviewProvider } from '../deployment/coolify.js';
import { NetlifyProvider } from '../deployment/netlify.js';
import { CloudflareProvider } from '../deployment/cloudflare.js';
import type { DeploymentProvider } from '../deployment/types.js';
import type { DeploymentProviderName, WorkbenchConfig } from '../types.js';

export interface WorkbenchContext {
  config: WorkbenchConfig;
  orchestrator: Orchestrator;
  policyEngine: PolicyEngine;
  portAllocator: PortAllocator;
  secretManager: SecretManager;
  secretPolicy: SecretPolicy;
  sandboxBroker: SandboxBroker;
  memoryService: MemoryService;
  skillsRegistry: SkillsRegistry;
  sessionService: SessionService;
  getDeploymentProvider(name: DeploymentProviderName): DeploymentProvider;
  getAgentProvider(name: 'claude' | 'codex' | 'copilot'): AgentProvider;
  close(): void;
}

export function createWorkbench(configPath?: string): WorkbenchContext {
  loadCredentials();

  const config = loadConfig(configPath);
  const policyEngine = new PolicyEngine();
  const portAllocator = new PortAllocator(config.ports, config.workspace.id);
  const secretManager = new SecretManager(config);
  const secretPolicy = new SecretPolicy(config);
  const sandboxBroker = new SandboxBroker();
  const memoryService = new MemoryService();
  const skillsRegistry = new SkillsRegistry();
  const sessionService = new SessionService();

  const orchestrator = new Orchestrator(
    config, policyEngine, portAllocator,
    secretManager, secretPolicy, sandboxBroker, sessionService,
  );

  const deployProviders: Partial<Record<DeploymentProviderName, DeploymentProvider>> = {};
  const agentProviders: Partial<Record<string, AgentProvider>> = {};

  function getDeploymentProvider(name: DeploymentProviderName): DeploymentProvider {
    if (!deployProviders[name]) {
      switch (name) {
        case 'coolify': deployProviders[name] = new CoolifyPreviewProvider(); break;
        case 'netlify': deployProviders[name] = new NetlifyProvider(); break;
        case 'cloudflare': deployProviders[name] = new CloudflareProvider(); break;
      }
    }
    return deployProviders[name]!;
  }

  function getAgentProvider(name: 'claude' | 'codex' | 'copilot'): AgentProvider {
    if (!agentProviders[name]) {
      switch (name) {
        case 'claude': agentProviders[name] = new ClaudeProvider(); break;
        default: throw new Error(`Agent provider "${name}" is not yet implemented`);
      }
    }
    return agentProviders[name]!;
  }

  return {
    config,
    orchestrator,
    policyEngine,
    portAllocator,
    secretManager,
    secretPolicy,
    sandboxBroker,
    memoryService,
    skillsRegistry,
    sessionService,
    getDeploymentProvider,
    getAgentProvider,
    close: () => { /* no-op: file-first, no connections to close */ },
  };
}
