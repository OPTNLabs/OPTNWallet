import type { AddonManifest } from '../../types/addons';
import {
  createPublicAddonSDK,
  type AddonExecutionResult,
  type AddonPublicSDK,
} from '../AddonsSDK';

/** Deterministic host options for third-party integration tests. */
export type MockAddonHostOptions = {
  walletId?: number;
  network?: string;
  addresses?: string[];
  approveExecution?: boolean;
};

/**
 * Creates a secret-free SDK host for add-on tests and examples.
 *
 * This never creates keys, signs, broadcasts, or contacts a provider. A
 * successful execution is reported as `submission_unknown` so integrations
 * must handle reconciliation instead of accidentally treating a mock result
 * as chain confirmation.
 */
export function createMockPublicAddonSDK(
  manifest: AddonManifest,
  options: MockAddonHostOptions = {}
): AddonPublicSDK {
  const addresses = new Set(options.addresses ?? []);
  let executionSequence = 0;
  const executeProposal = async (): Promise<AddonExecutionResult> => ({
    operationId: `mock-operation-${++executionSequence}`,
    status: 'submission_unknown',
  });
  return createPublicAddonSDK(manifest, {
    walletId: options.walletId ?? 1,
    network: options.network ?? 'chipnet',
    walletAddresses: addresses,
    requireAddressAllowlist: true,
    approveExecution: async () => options.approveExecution ?? true,
    executeProposal,
    sessionId: 'mock-session',
    grantRevision: 1,
    authorityEpoch: 1,
  });
}
