import p2pkhArtifact from './artifacts/p2pkh.json';
import bip38Artifact from './artifacts/bip38.json';
import transferWithTimeoutArtifact from './artifacts/transfer_with_timeout.json';
import escrowArtifact from './artifacts/escrow.json';
import escrowMS2Artifact from './artifacts/escrowMS2.json';
import MSVault from './artifacts/MSVault.json';
import AuthGuardArtifact from './artifacts/AuthGuard.json';
import type { ContractArtifact } from './types';

export function createBuiltinArtifactCache(): Record<string, ContractArtifact> {
  return {
    p2pkh: p2pkhArtifact as ContractArtifact,
    transfer_with_timeout: transferWithTimeoutArtifact as ContractArtifact,
    escrow: escrowArtifact as ContractArtifact,
    escrowMS2: escrowMS2Artifact as ContractArtifact,
    bip38: bip38Artifact as ContractArtifact,
    msVault: MSVault as ContractArtifact,
    authguard: AuthGuardArtifact as ContractArtifact,
  };
}
