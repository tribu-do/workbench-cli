/**
 * DeploymentProvider port — shared contract for all preview providers.
 * Implements LLD-3.
 */

import type {
  DeploymentProviderName,
  DeploymentKind,
  PreviewInput,
  PreviewHandle,
  PreviewStatus,
} from '../types.js';

export interface DeploymentProvider {
  name: DeploymentProviderName;
  kind: DeploymentKind;

  deployPreview(input: PreviewInput): Promise<PreviewHandle>;
  getStatus(handle: PreviewHandle): Promise<PreviewStatus>;
  attachCustomDomain(handle: PreviewHandle, domain: string): Promise<void>;
  destroy(handle: PreviewHandle): Promise<void>;
}
