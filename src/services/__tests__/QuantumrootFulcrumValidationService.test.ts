import { beforeEach, describe, expect, it, vi } from 'vitest';

import ElectrumService from '../ElectrumService';
import {
  validateQuantumrootAuthorizedSpendAgainstFulcrum,
  type QuantumrootAuthorizedSpendFulcrumValidationRequest,
} from '../QuantumrootFulcrumValidationService';
import { buildQuantumrootAuthorizedSpendTransaction } from '../QuantumrootRecoveryService';
import { deriveQuantumrootVault, zeroizeQuantumrootArtifacts } from '../QuantumrootService';
import { deriveBchKeyMaterial } from '../HdWalletService';
import { Network } from '../../state/slices/networkSlice';

vi.mock('../ElectrumService', () => ({
  default: {
    getUTXOsMany: vi.fn(),
  },
}));

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('QuantumrootFulcrumValidationService', () => {
  const mockedElectrumService = vi.mocked(ElectrumService);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function makeRequest() {
    const controlCategory =
      '00112233445566778899aabbccddeefffedcba98765432100123456789abcdef';
    const vault = await deriveQuantumrootVault(
      Network.CHIPNET,
      TEST_MNEMONIC,
      '',
      0,
      30,
      '0',
      controlCategory
    );
    const successorVault = await deriveQuantumrootVault(
      Network.CHIPNET,
      TEST_MNEMONIC,
      '',
      0,
      31,
      '0',
      controlCategory
    );
    const destination = await deriveBchKeyMaterial(
      Network.CHIPNET,
      TEST_MNEMONIC,
      '',
      0,
      0,
      17
    );
    if (!destination) {
      throw new Error('Failed to derive destination address for validation test.');
    }

    const request: QuantumrootAuthorizedSpendFulcrumValidationRequest = {
      controlTokenUtxo: {
        address: vault.quantumLockAddress,
        amount: 546,
        value: 546,
        height: 0,
        tx_hash: 'cc'.repeat(31) + '01',
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
          tx_hash: 'dd'.repeat(31) + '01',
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
      rawTransaction: '',
      successorQuantumLockAddress: successorVault.quantumLockAddress,
      successorQuantumLockLockingBytecode: successorVault.quantumLockLockingBytecode,
      vault,
      vaultTokenCategory: controlCategory,
    };

    try {
      const built = buildQuantumrootAuthorizedSpendTransaction(request);
      return { built, request, successorVault, vault };
    } catch (error) {
      zeroizeQuantumrootArtifacts(vault);
      zeroizeQuantumrootArtifacts(successorVault);
      throw error;
    }
  }

  it('validates the authorized spend against Fulcrum first', async () => {
    const { built, request, successorVault, vault } = await makeRequest();

    mockedElectrumService.getUTXOsMany.mockResolvedValue({
      [vault.quantumLockAddress]: [request.controlTokenUtxo],
      [vault.receiveAddress]: request.receiveUtxos,
    });

    try {
      const result = await validateQuantumrootAuthorizedSpendAgainstFulcrum({
        ...request,
        rawTransaction: built.rawTransaction,
      });

      expect(result.validationMode).toBe('fulcrum-preflight');
      expect(result.inputCount).toBe(2);
      expect(result.outputCount).toBe(2);
      expect(result.checkedAddresses).toEqual(
        expect.arrayContaining([vault.quantumLockAddress, vault.receiveAddress])
      );
      expect(result.checkedOutpoints).toEqual(
        expect.arrayContaining([
          `${request.controlTokenUtxo.tx_hash}:${request.controlTokenUtxo.tx_pos}`,
          `${request.receiveUtxos[0].tx_hash}:${request.receiveUtxos[0].tx_pos}`,
        ])
      );
      expect(mockedElectrumService.getUTXOsMany).toHaveBeenCalledTimes(1);
      expect(mockedElectrumService.getUTXOsMany).toHaveBeenCalledWith([
        vault.quantumLockAddress,
        vault.receiveAddress,
      ]);
    } finally {
      zeroizeQuantumrootArtifacts(vault);
      zeroizeQuantumrootArtifacts(successorVault);
    }
  });

  it('rejects when Fulcrum does not show the requested control token', async () => {
    const { built, request, successorVault, vault } = await makeRequest();

    mockedElectrumService.getUTXOsMany.mockResolvedValue({
      [vault.quantumLockAddress]: [],
      [vault.receiveAddress]: request.receiveUtxos,
    });

    try {
      await expect(
        validateQuantumrootAuthorizedSpendAgainstFulcrum({
          ...request,
          rawTransaction: built.rawTransaction,
        })
      ).rejects.toThrow(
        'Quantumroot authorized spend control token UTXO is not currently visible on the chipnet entry-point.'
      );
    } finally {
      zeroizeQuantumrootArtifacts(vault);
      zeroizeQuantumrootArtifacts(successorVault);
    }
  });

  it('rejects when the raw transaction destination does not match the request', async () => {
    const { built, request, successorVault, vault } = await makeRequest();
    const destination = await deriveBchKeyMaterial(
      Network.CHIPNET,
      TEST_MNEMONIC,
      '',
      0,
      0,
      19
    );
    if (!destination) {
      throw new Error('Failed to derive mismatched destination for validation test.');
    }

    mockedElectrumService.getUTXOsMany.mockResolvedValue({
      [vault.quantumLockAddress]: [request.controlTokenUtxo],
      [vault.receiveAddress]: request.receiveUtxos,
    });

    try {
      await expect(
        validateQuantumrootAuthorizedSpendAgainstFulcrum({
          ...request,
          destinationAddress: destination.address,
          rawTransaction: built.rawTransaction,
        })
      ).rejects.toThrow(
        'Quantumroot authorized spend destination output does not match the requested destination address.'
      );
    } finally {
      zeroizeQuantumrootArtifacts(vault);
      zeroizeQuantumrootArtifacts(successorVault);
    }
  });
});
