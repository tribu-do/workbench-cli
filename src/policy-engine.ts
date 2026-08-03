/**
 * PolicyEngine — Evaluates runtime mode + auto_approve decisions.
 * Implements LLD-5 policy rules.
 */

import type {
  TaskSpec,
  RuntimeProbe,
  PolicyVerdict,
  IsolationTier,
} from './types.js';

export class PolicyEngine {
  /**
   * Evaluate policy for a task given a runtime probe.
   * Rules ordered per LLD-5:
   * 1. daemon-managed + AIO healthy → strong, auto_approve permitted
   * 2. dev-managed + shim + pty-wrap → medium, auto_approve permitted
   * 3. dev-managed + pty-wrap only → medium, auto_approve forbidden
   * 4. bare-host → weak, auto_approve forbidden
   * 5. GPU required but not present → fail
   */
  evaluate(spec: TaskSpec, probe: RuntimeProbe): PolicyVerdict {
    const reasons: string[] = [];
    let isolationTier: IsolationTier;
    let effectiveAutoApprove = spec.autoApprove ?? false;

    switch (probe.runtimeMode) {
      case 'daemon-managed': {
        if (probe.aioHealthy) {
          isolationTier = 'strong';
          reasons.push('Daemon-managed mode with healthy AIO sandbox: strong isolation, auto_approve permitted.');
        } else if (probe.dockerHealthy) {
          // G4 fallback path: Docker-only isolation (per LLD-2 §G4 fallback).
          // Container is the boundary; auto_approve permitted at medium tier.
          isolationTier = 'medium';
          reasons.push('Daemon-managed mode with healthy Docker (G4 fallback, no AIO): medium isolation, auto_approve permitted.');
        } else {
          isolationTier = 'weak';
          effectiveAutoApprove = false;
          reasons.push('Daemon-managed mode but no isolation layer healthy (no AIO, no Docker): auto_approve forbidden.');
        }
        break;
      }

      case 'dev-managed': {
        isolationTier = 'medium';
        if (probe.shimHealthy && probe.ptyWrapHealthy) {
          reasons.push('Dev-managed mode with shim + pty-wrap: medium isolation, auto_approve permitted.');
        } else if (probe.ptyWrapHealthy) {
          effectiveAutoApprove = false;
          reasons.push('Dev-managed mode with pty-wrap only (no shim): auto_approve downgraded to awaiting_approval.');
        } else {
          effectiveAutoApprove = false;
          reasons.push('Dev-managed mode without healthy mediation layers: auto_approve forbidden.');
        }
        break;
      }

      case 'bare-host': {
        isolationTier = 'weak';
        effectiveAutoApprove = false;
        reasons.push('Bare-host mode: weak isolation, auto_approve forbidden, observe-only.');
        break;
      }

      default: {
        isolationTier = 'weak';
        effectiveAutoApprove = false;
        reasons.push(`Unknown runtime mode "${probe.runtimeMode}": defaulting to weak.`);
      }
    }

    // GPU check
    if (spec.metadata?.requireGpu && !probe.gpuAvailable) {
      throw new PolicyError('GPU_UNAVAILABLE', 'Task requires GPU but none is available.');
    }

    return {
      effectiveAutoApprove,
      isolationTier,
      reasons,
    };
  }
}

export class PolicyError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}
