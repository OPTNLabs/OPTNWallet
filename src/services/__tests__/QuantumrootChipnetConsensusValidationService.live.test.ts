import { describe, expect, it, vi } from 'vitest';

import ElectrumService from '../ElectrumService';
import {
  validateQuantumrootAuthorizedSpendAgainstChipnet,
} from '../../../test-support/QuantumrootChipnetConsensusValidationService';
import { buildQuantumrootAuthorizedSpendTransaction } from '../QuantumrootRecoveryService';
import { deriveQuantumrootVault, zeroizeQuantumrootArtifacts } from '../QuantumrootService';
import { deriveBchKeyMaterial } from '../HdWalletService';
import { Network } from '../../state/slices/networkSlice';
import type { QuantumrootAuthorizedSpendBuildRequest } from '../QuantumrootRecoveryService';
import type { UTXO } from '../../types/types';

vi.mock('../ElectrumService', () => ({
  default: {
    getUTXOsMany: vi.fn(),
  },
}));

const RUN_LIVE_QUANTUMROOT = process.env.RUN_QUANTUMROOT_LIVE === '1';
const liveDescribe = RUN_LIVE_QUANTUMROOT ? describe : describe.skip;

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

liveDescribe('Quantumroot chipnet consensus smoke', () => {
  it('runs Fulcrum preflight first and then probes the local BCHN node over SSH', async () => {
    const mockedElectrumService = vi.mocked(ElectrumService);
    const controlCategory =
      '00112233445566778899aabbccddeefffedcba98765432100123456789abcdef';
    const vault = await deriveQuantumrootVault(
      Network.CHIPNET,
      TEST_MNEMONIC,
      '',
      0,
      34,
      '0',
      controlCategory
    );
    const successorVault = await deriveQuantumrootVault(
      Network.CHIPNET,
      TEST_MNEMONIC,
      '',
      0,
      35,
      '0',
      controlCategory
    );
    const destination = await deriveBchKeyMaterial(
      Network.CHIPNET,
      TEST_MNEMONIC,
      '',
      0,
      0,
      23
    );
    if (!destination) {
      throw new Error('Failed to derive destination address for live consensus smoke.');
    }

    try {
      const request: QuantumrootAuthorizedSpendBuildRequest = {
        controlTokenUtxo: {
          address: vault.quantumLockAddress,
          amount: 546,
          value: 546,
          height: 0,
          tx_hash: 'ef'.repeat(31) + '01',
          tx_pos: 0,
          token: {
            amount: 0,
            category: controlCategory,
            nft: {
              capability: 'none',
              commitment: '',
            },
          },
        },
        destinationAddress: destination.address,
        receiveUtxos: [
          {
            address: vault.receiveAddress,
            amount: 20_000,
            value: 20_000,
            height: 0,
            tx_hash: 'fe'.repeat(31) + '01',
            tx_pos: 1,
            token: {
              amount: 0,
              category: controlCategory,
              nft: {
                capability: 'none',
                commitment: '',
              },
            },
          },
        ],
        successorQuantumLockAddress: successorVault.quantumLockAddress,
        successorQuantumLockLockingBytecode:
          successorVault.quantumLockLockingBytecode,
        vault,
        vaultTokenCategory: controlCategory,
      };

      const built = buildQuantumrootAuthorizedSpendTransaction(request);
      mockedElectrumService.getUTXOsMany.mockResolvedValue({
        [vault.quantumLockAddress]: [request.controlTokenUtxo],
        [vault.receiveAddress]: request.receiveUtxos,
      } as Record<string, UTXO[]>);

      const result = await validateQuantumrootAuthorizedSpendAgainstChipnet({
        ...request,
        rawTransaction: built.rawTransaction,
      });

      expect(result.consensusSource).toBe('bchn');
      expect(result.nodeConsensus.available).toBe(true);
      expect(result.nodeConsensus.allowed).toBe(false);
      expect(typeof result.nodeConsensus.reason).toBe('string');
      expect(result.nodeConsensus.reason?.length).toBeGreaterThan(0);
      expect(mockedElectrumService.getUTXOsMany).toHaveBeenCalledTimes(1);
    } finally {
      zeroizeQuantumrootArtifacts(vault);
      zeroizeQuantumrootArtifacts(successorVault);
    }
  }, 45_000);
});
