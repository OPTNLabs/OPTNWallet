import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';

import ElectrumService from '../ElectrumService';
import {
  createQuantumrootChipnetNodeValidator,
  validateQuantumrootAuthorizedSpendAgainstChipnet,
} from '../../../test-support/QuantumrootChipnetConsensusValidationService';
import {
  buildQuantumrootAuthorizedSpendTransaction,
  type QuantumrootAuthorizedSpendBuildRequest,
} from '../QuantumrootRecoveryService';
import { deriveQuantumrootVault, zeroizeQuantumrootArtifacts } from '../QuantumrootService';
import { deriveBchKeyMaterial } from '../HdWalletService';
import { Network } from '../../state/slices/networkSlice';

vi.mock('../ElectrumService', () => ({
  default: {
    getUTXOsMany: vi.fn(),
  },
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('QuantumrootChipnetConsensusValidationService', () => {
  const mockedElectrumService = vi.mocked(ElectrumService);
  const mockedExecFile = vi.mocked(execFile);

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
      32,
      '0',
      controlCategory
    );
    const successorVault = await deriveQuantumrootVault(
      Network.CHIPNET,
      TEST_MNEMONIC,
      '',
      0,
      33,
      '0',
      controlCategory
    );
    const destination = await deriveBchKeyMaterial(
      Network.CHIPNET,
      TEST_MNEMONIC,
      '',
      0,
      0,
      21
    );
    if (!destination) {
      throw new Error('Failed to derive destination address for consensus test.');
    }

    const request: QuantumrootAuthorizedSpendBuildRequest = {
      controlTokenUtxo: {
        address: vault.quantumLockAddress,
        amount: 546,
        value: 546,
        height: 0,
        tx_hash: 'aa'.repeat(31) + '01',
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
          tx_hash: 'bb'.repeat(31) + '01',
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

  it('uses Fulcrum first and then the provided node validator', async () => {
    const { built, request, successorVault, vault } = await makeRequest();

    mockedElectrumService.getUTXOsMany.mockResolvedValue({
      [vault.quantumLockAddress]: [request.controlTokenUtxo],
      [vault.receiveAddress]: request.receiveUtxos,
    });

    const nodeValidator = vi.fn(async () => ({
      allowed: true,
      available: true,
      rawResponse: [{ allowed: true }],
      reason: null,
    }));

    try {
      const result = await validateQuantumrootAuthorizedSpendAgainstChipnet(
        {
          ...request,
          rawTransaction: built.rawTransaction,
        },
        { nodeValidator }
      );

      expect(result.consensusSource).toBe('bchn');
      expect(result.nodeConsensus.allowed).toBe(true);
      expect(nodeValidator).toHaveBeenCalledWith(built.rawTransaction);
      expect(mockedElectrumService.getUTXOsMany).toHaveBeenCalledWith([
        vault.quantumLockAddress,
        vault.receiveAddress,
      ]);
    } finally {
      zeroizeQuantumrootArtifacts(vault);
      zeroizeQuantumrootArtifacts(successorVault);
    }
  });

  it('builds the SSH node validator command against the local chipnet container', async () => {
    mockedExecFile.mockImplementation(
      (
        _command: string,
        _args: readonly string[],
        _options: unknown,
        callback: (error: Error | null, stdout?: string, stderr?: string) => void
      ) => {
        callback(null, '[{"allowed":false,"reject-reason":"missing-inputs"}]', '');
        return undefined as never;
      }
    );

    const validator = createQuantumrootChipnetNodeValidator({
      bitcoinCliConfigPath: '/data/bitcoin.conf',
      containerName: 'bch-chipnet',
      sshTarget: 'lightswarm@192.168.31.218',
      timeoutMs: 1_000,
    });

    const result = await validator('deadbeef');

    expect(result.available).toBe(true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('missing-inputs');
    expect(mockedExecFile).toHaveBeenCalledTimes(1);

    const [command, args] = mockedExecFile.mock.calls[0] as unknown as [
      string,
      readonly string[],
    ];
    expect(command).toBe('ssh');
    expect(args[0]).toBe('lightswarm@192.168.31.218');
    expect(args[1]).toContain('docker exec');
    expect(args[1]).toContain('bch-chipnet');
    expect(args[1]).toContain('bitcoin-cli');
    expect(args[1]).toContain("-conf='/data/bitcoin.conf'");
    expect(args[1]).toContain('testmempoolaccept');
    expect(args[1]).toContain('deadbeef');
  });
});
