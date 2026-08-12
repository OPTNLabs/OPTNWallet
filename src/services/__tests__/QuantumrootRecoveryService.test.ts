import { describe, expect, it } from 'vitest';
import {
  assertSuccess,
  binToHex,
  createCompilerGenerateBytecodeFunction,
  createCompilerBCH,
  decodeAuthenticationInstructions,
  decodeTransaction,
  disassembleBytecodeBch,
  hash256,
  hexToBin,
  importWalletTemplate,
  lockingBytecodeToCashAddress,
  walletTemplateToCompilerBCH,
  walletTemplateToCompilerConfiguration,
} from '@bitauth/libauth';
import { compileScriptRaw } from '@bitauth/libauth/build/lib/language/resolve.js';

import quantumrootTemplateJson from '../../../../reference/quantumroot/quantumroot-schnorr-lm-ots-vault.json';
import { Network } from '../../redux/networkSlice';
import { deriveQuantumrootVault, zeroizeQuantumrootArtifacts } from '../QuantumrootService';
import {
  buildQuantumrootAuthorizedSpendTransaction,
  buildQuantumrootAggregateRecoverySweepTransaction,
  buildQuantumrootQuantumLockRecoveryTransaction,
  buildQuantumrootRecoveryTransaction,
} from '../QuantumrootRecoveryService';
import { deriveBchKeyMaterial } from '../HdWalletService';

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const importedQuantumrootTemplate = importWalletTemplate(quantumrootTemplateJson);

if (typeof importedQuantumrootTemplate === 'string') {
  throw new Error(importedQuantumrootTemplate);
}

function instructionHasData(
  instruction: ReturnType<typeof decodeAuthenticationInstructions>[number]
): instruction is Extract<
  ReturnType<typeof decodeAuthenticationInstructions>[number],
  { data: Uint8Array }
> {
  return 'data' in instruction && instruction.data !== undefined;
}

describe('QuantumrootRecoveryService', () => {
  it('builds a locally verifiable Quantumroot schnorr recovery transaction', async () => {
    const vault = await deriveQuantumrootVault(
      Network.CHIPNET,
      TEST_MNEMONIC,
      '',
      0,
      0
    );
    const destination = await deriveBchKeyMaterial(
      Network.CHIPNET,
      TEST_MNEMONIC,
      '',
      0,
      0,
      7
    );
    if (!destination) {
      throw new Error('Failed to derive destination address for recovery test.');
    }

    try {
      const result = buildQuantumrootRecoveryTransaction({
        destinationAddress: destination.address,
        utxo: {
          address: vault.receiveAddress,
          amount: 20_000,
          value: 20_000,
          height: 0,
          tx_hash: '00'.repeat(31) + '01',
          tx_pos: 0,
        },
        vault,
      });

      expect(result.feeSats).toBeGreaterThan(0n);
      expect(result.recoveryAmountSats).toBe(20_000n - result.feeSats);

      const decoded = decodeTransaction(hexToBin(result.rawTransaction));
      if (typeof decoded === 'string') {
        throw new Error(decoded);
      }

      expect(decoded.inputs).toHaveLength(1);
      expect(decoded.outputs).toHaveLength(1);
      expect(decoded.outputs[0].valueSatoshis).toBe(result.recoveryAmountSats);

      const recoveredDestination = lockingBytecodeToCashAddress({
        bytecode: decoded.outputs[0].lockingBytecode,
        prefix: 'bchtest',
      });
      if (typeof recoveredDestination === 'string') {
        throw new Error(recoveredDestination);
      }
      expect(recoveredDestination.address).toBe(destination.address);

      const compiler = createCompilerBCH(
        walletTemplateToCompilerConfiguration(importedQuantumrootTemplate)
      );
      const rawReceiveAddress = compileScriptRaw({
        configuration: compiler.configuration,
        data: {
          hdKeys: {
            addressIndex: vault.addressIndex,
            hdPrivateKeys: { owner: vault.accountHdPrivateKey },
          },
          bytecode: {
            leaf_spend_index: '0',
            online_quantum_signer: '0',
            quantum_spend_index: '0',
            token_spend_index: '0',
            vault_token_category: '00'.repeat(32),
          },
          compilationContext: {
            inputIndex: 0,
            sourceOutputs: [
              {
                lockingBytecode: vault.receiveLockingBytecode,
                valueSatoshis: 20_000n,
              },
            ],
            transaction: {
              version: 2,
              locktime: 0,
              inputs: [
                {
                  outpointIndex: 0,
                  outpointTransactionHash: hexToBin('00'.repeat(31) + '01'),
                  sequenceNumber: 0,
                  unlockingBytecode: Uint8Array.of(),
                },
              ],
              outputs: [
                {
                  lockingBytecode: decoded.outputs[0].lockingBytecode,
                  valueSatoshis: result.recoveryAmountSats,
                },
              ],
            },
          },
        } as any,
        scriptId: 'receive_address',
      });
      expect(rawReceiveAddress.success).toBe(true);
      if (!rawReceiveAddress.success) {
        throw new Error(
          `Failed to compile raw receive_address redeem script: ${JSON.stringify(
            (rawReceiveAddress as any).errors
          )}`
        );
      }

      const unlockPushInstructions = decodeAuthenticationInstructions(
        decoded.inputs[0].unlockingBytecode
      ) as Array<{ data?: Uint8Array }>;
      const unlockPushes = unlockPushInstructions
        .filter((instruction) => instruction.data !== undefined)
        .map((instruction) => instruction.data as Uint8Array);

      expect(
        unlockPushes.some(
          (push) => binToHex(push) === binToHex(rawReceiveAddress.bytecode)
        )
      ).toBe(true);
    } finally {
      zeroizeQuantumrootArtifacts(vault);
    }
  });

  it('builds a locally verifiable aggregated Quantumroot sweep transaction across multiple receive UTXOs', async () => {
    const vault = await deriveQuantumrootVault(
      Network.CHIPNET,
      TEST_MNEMONIC,
      '',
      0,
      4
    );
    const destination = await deriveBchKeyMaterial(
      Network.CHIPNET,
      TEST_MNEMONIC,
      '',
      0,
      0,
      11
    );
    if (!destination) {
      throw new Error('Failed to derive destination address for sweep test.');
    }

    try {
      const result = buildQuantumrootAggregateRecoverySweepTransaction({
        destinationAddress: destination.address,
        utxos: [
          {
            address: vault.receiveAddress,
            amount: 20_000,
            value: 20_000,
            height: 0,
            tx_hash: 'aa'.repeat(31) + '01',
            tx_pos: 0,
          },
          {
            address: vault.receiveAddress,
            amount: 35_000,
            value: 35_000,
            height: 0,
            tx_hash: 'bb'.repeat(31) + '02',
            tx_pos: 1,
          },
        ],
        vault,
      });

      expect(result.inputCount).toBe(2);
      expect(result.feeSats).toBeGreaterThan(0n);
      expect(result.recoveryAmountSats).toBeGreaterThan(0n);

      const decoded = decodeTransaction(hexToBin(result.rawTransaction));
      if (typeof decoded === 'string') {
        throw new Error(decoded);
      }

      expect(decoded.inputs).toHaveLength(2);
      expect(decoded.outputs).toHaveLength(1);
      expect(decoded.outputs[0].valueSatoshis).toBe(result.recoveryAmountSats);

      const recoveredDestination = lockingBytecodeToCashAddress({
        bytecode: decoded.outputs[0].lockingBytecode,
        prefix: 'bchtest',
      });
      if (typeof recoveredDestination === 'string') {
        throw new Error(recoveredDestination);
      }
      expect(recoveredDestination.address).toBe(destination.address);
    } finally {
      zeroizeQuantumrootArtifacts(vault);
    }
  });

  it('documents that authorized Quantumroot spend is currently blocked by the token-spend leaf mismatch', async () => {
    const vault = await deriveQuantumrootVault(
      Network.CHIPNET,
      TEST_MNEMONIC,
      '',
      0,
      14,
      '0',
      '55'.repeat(32)
    );
    const successorVault = await deriveQuantumrootVault(
      Network.CHIPNET,
      TEST_MNEMONIC,
      '',
      0,
      15,
      '0',
      '55'.repeat(32)
    );
    const destination = await deriveBchKeyMaterial(
      Network.CHIPNET,
      TEST_MNEMONIC,
      '',
      0,
      0,
      12
    );
    if (!destination) {
      throw new Error('Failed to derive destination address for authorized spend test.');
    }

    try {
      expect(() =>
        buildQuantumrootAuthorizedSpendTransaction({
          controlTokenUtxo: {
            address: vault.quantumLockAddress,
            amount: 546,
            value: 546,
            height: 0,
            tx_hash: 'cc'.repeat(31) + '01',
            tx_pos: 0,
            token: {
              amount: 1,
              category: '55'.repeat(32),
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
            },
            {
              address: vault.receiveAddress,
              amount: 35_000,
              value: 35_000,
              height: 0,
              tx_hash: 'ee'.repeat(31) + '01',
              tx_pos: 2,
            },
          ],
          successorQuantumLockAddress: successorVault.quantumLockAddress,
          successorQuantumLockLockingBytecode: successorVault.quantumLockLockingBytecode,
          vault,
          vaultTokenCategory: '55'.repeat(32),
        })
      ).toThrow('Program failed an OP_VERIFY operation');
    } finally {
      zeroizeQuantumrootArtifacts(vault);
      zeroizeQuantumrootArtifacts(successorVault);
    }
  });

  it('rejects authorized spend when the Quantum Lock control token category does not match', async () => {
    const vault = await deriveQuantumrootVault(
      Network.CHIPNET,
      TEST_MNEMONIC,
      '',
      0,
      16,
      '0',
      '66'.repeat(32)
    );

    try {
      expect(() =>
        buildQuantumrootAuthorizedSpendTransaction({
          controlTokenUtxo: {
            address: vault.quantumLockAddress,
            amount: 546,
            value: 546,
            height: 0,
            tx_hash: 'ff'.repeat(31) + '01',
            tx_pos: 0,
            token: {
              amount: 1,
              category: '77'.repeat(32),
            },
          },
          destinationAddress: vault.receiveAddress,
          receiveUtxos: [
            {
              address: vault.receiveAddress,
              amount: 20_000,
              value: 20_000,
              height: 0,
              tx_hash: '11'.repeat(31) + '02',
              tx_pos: 1,
            },
          ],
          successorQuantumLockAddress: vault.quantumLockAddress,
          successorQuantumLockLockingBytecode: vault.quantumLockLockingBytecode,
          vault,
          vaultTokenCategory: '66'.repeat(32),
        })
      ).toThrow('Quantumroot authorized spend requires a matching control token category.');
    } finally {
      zeroizeQuantumrootArtifacts(vault);
    }
  });

  it(
    'documents that libauth scenario generation still produces a schnorr unlock whose final push does not match the receive-address p2sh hash',
    async () => {
    const vault = await deriveQuantumrootVault(
      Network.CHIPNET,
      TEST_MNEMONIC,
      '',
      0,
      5
    );

    try {
      const compiler = createCompilerBCH(
        walletTemplateToCompilerConfiguration({
          ...importedQuantumrootTemplate,
          scenarios: {
            base: importedQuantumrootTemplate.scenarios?.base,
            manual: {
              extends: 'base',
              data: {
                bytecode: {
                  leaf_spend_index: '0',
                  online_quantum_signer: '0',
                  quantum_spend_index: '0',
                  token_spend_index: '0',
                  vault_token_category: '00'.repeat(32),
                },
                hdKeys: {
                  addressIndex: vault.addressIndex,
                },
                hdPrivateKeys: {
                  owner: vault.accountHdPrivateKey,
                },
              } as unknown as NonNullable<
                (typeof importedQuantumrootTemplate.scenarios)['base']
              >['data'],
              sourceOutputs: [
                {
                  lockingBytecode: ['slot'],
                  valueSatoshis: 20_000,
                },
              ],
              transaction: {
                inputs: [
                  {
                    outpointIndex: 0,
                    outpointTransactionHash: '00'.repeat(31) + '01',
                    sequenceNumber: 0,
                    unlockingBytecode: ['slot'],
                  },
                ],
                outputs: [
                  {
                    lockingBytecode: '6a',
                    valueSatoshis: 19_000,
                  },
                ],
              },
            },
          },
        })
      );

      const generated = assertSuccess(
        compiler.generateScenario({
          scenarioId: 'manual',
          unlockingScriptId: 'schnorr_spend',
        })
      );

      const unlockInstructions = decodeAuthenticationInstructions(
        generated.program.transaction.inputs[0].unlockingBytecode
      ) as Array<{ data?: Uint8Array }>;
      const redeemPush = [...unlockInstructions]
        .reverse()
        .find((instruction) => instruction.data !== undefined);

      const lockingInstructions = decodeAuthenticationInstructions(
        vault.receiveLockingBytecode
      ) as Array<{ data?: Uint8Array }>;
      const receiveLockingDisassembly = disassembleBytecodeBch(
        vault.receiveLockingBytecode
      );
      const committedHashPush = lockingInstructions.find(
        (instruction) =>
          instruction.data !== undefined && instruction.data.length === 32
      );

      expect(receiveLockingDisassembly.startsWith('OP_HASH256')).toBe(true);
      expect(receiveLockingDisassembly.endsWith('OP_EQUAL')).toBe(true);

      expect(redeemPush && 'data' in redeemPush).toBe(true);
      expect(committedHashPush && 'data' in committedHashPush).toBe(true);

      if (!redeemPush?.data) {
        throw new Error('Generated unlock missing redeem-script push.');
      }
      if (!committedHashPush?.data) {
        throw new Error('Receive address locking bytecode missing p2sh hash.');
      }

      expect(hash256(redeemPush.data)).not.toEqual(committedHashPush.data);
    } finally {
      zeroizeQuantumrootArtifacts(vault);
    }
  });

  it('documents that libauth scenario generation includes no pushed redeem script matching the receive-address p2sh commitment', async () => {
    const vault = await deriveQuantumrootVault(
      Network.CHIPNET,
      TEST_MNEMONIC,
      '',
      0,
      6
    );

    try {
      const scenarioCompiler = createCompilerBCH(
        walletTemplateToCompilerConfiguration({
          ...importedQuantumrootTemplate,
          scenarios: {
            base: importedQuantumrootTemplate.scenarios?.base,
            manual: {
              extends: 'base',
              data: {
                bytecode: {
                  leaf_spend_index: '0',
                  online_quantum_signer: '0',
                  quantum_spend_index: '0',
                  token_spend_index: '0',
                  vault_token_category: '00'.repeat(32),
                },
                hdKeys: {
                  addressIndex: vault.addressIndex,
                },
                hdPrivateKeys: {
                  owner: vault.accountHdPrivateKey,
                },
              } as unknown as NonNullable<
                (typeof importedQuantumrootTemplate.scenarios)['base']
              >['data'],
              sourceOutputs: [
                {
                  lockingBytecode: ['slot'],
                  valueSatoshis: 20_000,
                },
              ],
              transaction: {
                inputs: [
                  {
                    outpointIndex: 0,
                    outpointTransactionHash: '00'.repeat(31) + '01',
                    sequenceNumber: 0,
                    unlockingBytecode: ['slot'],
                  },
                ],
                outputs: [
                  {
                    lockingBytecode: '6a',
                    valueSatoshis: 19_000,
                  },
                ],
              },
            },
          },
        })
      );

      const generated = assertSuccess(
        scenarioCompiler.generateScenario({
          scenarioId: 'manual',
          unlockingScriptId: 'schnorr_spend',
        })
      );
      const unlockInstructions = decodeAuthenticationInstructions(
        generated.program.transaction.inputs[0].unlockingBytecode
      ) as Array<{ data?: Uint8Array }>;
      const pushedData = unlockInstructions.filter(
        (instruction) => instruction.data !== undefined
      ) as Array<{ data: Uint8Array }>;

      const oldCompiler = walletTemplateToCompilerBCH(importedQuantumrootTemplate);
      const oldNested = oldCompiler.generateBytecode({
        scriptId: 'receive_address',
        data: {
          hdKeys: {
            addressIndex: vault.addressIndex,
            hdPrivateKeys: { owner: vault.accountHdPrivateKey },
          },
          bytecode: {
            leaf_spend_index: '0',
            online_quantum_signer: '0',
            quantum_spend_index: '0',
            token_spend_index: '0',
            vault_token_category: '00'.repeat(32),
          },
        } as any,
      });

      const newCompiler = createCompilerBCH(
        walletTemplateToCompilerConfiguration(importedQuantumrootTemplate)
      );
      const newNested = newCompiler.generateBytecode({
        scriptId: 'receive_address',
        data: {
          hdKeys: {
            addressIndex: vault.addressIndex,
            hdPrivateKeys: { owner: vault.accountHdPrivateKey },
          },
          bytecode: {
            leaf_spend_index: '0',
            online_quantum_signer: '0',
            quantum_spend_index: '0',
            token_spend_index: '0',
            vault_token_category: '00'.repeat(32),
          },
        } as any,
      });
      expect(oldNested.success).toBe(true);
      expect(newNested.success).toBe(true);

      if (!oldNested.success || !newNested.success) {
        throw new Error('One of the candidate compile paths failed unexpectedly.');
      }

      const oldNestedHex = binToHex(oldNested.bytecode);
      const newNestedHex = binToHex(newNested.bytecode);

      const lockingInstructions = decodeAuthenticationInstructions(
        vault.receiveLockingBytecode
      ) as Array<{ data?: Uint8Array }>;
      const committedHashPush = lockingInstructions.find(
        (instruction) =>
          instruction.data !== undefined && instruction.data.length === 32
      );

      if (!committedHashPush?.data) {
        throw new Error('Receive address locking bytecode missing p2sh hash.');
      }

      const matchingPush = pushedData.find(
        (push) => binToHex(hash256(push.data)) === binToHex(committedHashPush.data)
      );

      expect(matchingPush).toBeUndefined();
      expect(
        pushedData.some((push) => {
          const hex = binToHex(push.data);
          return hex === oldNestedHex || hex === newNestedHex;
        })
      ).toBe(false);
    } finally {
      zeroizeQuantumrootArtifacts(vault);
    }
  });

  it('contains the raw receive_address redeem script in the generated schnorr unlock', async () => {
    const vault = await deriveQuantumrootVault(
      Network.CHIPNET,
      TEST_MNEMONIC,
      '',
      0,
      12
    );

    try {
      const compiler = createCompilerBCH(
        walletTemplateToCompilerConfiguration(importedQuantumrootTemplate)
      );
      const configuration = compiler.configuration;
      const generateBytecode = createCompilerGenerateBytecodeFunction(configuration);
      const compilationData = {
        hdKeys: {
          addressIndex: vault.addressIndex,
          hdPrivateKeys: { owner: vault.accountHdPrivateKey },
        },
        bytecode: {
          leaf_spend_index: '0',
          online_quantum_signer: '0',
          quantum_spend_index: '0',
          token_spend_index: '0',
          vault_token_category: '00'.repeat(32),
        },
        compilationContext: {
          inputIndex: 0,
          sourceOutputs: [
            {
              lockingBytecode: vault.receiveLockingBytecode,
              valueSatoshis: 20_000n,
            },
          ],
          transaction: {
            inputs: [
              {
                outpointIndex: 0,
                outpointTransactionHash: hexToBin('00'.repeat(31) + '01'),
                sequenceNumber: 0,
                unlockingBytecode: Uint8Array.of(),
              },
            ],
            locktime: 0,
            outputs: [
              {
                lockingBytecode: hexToBin('6a'),
                valueSatoshis: 19_000n,
              },
            ],
            version: 2,
          },
        },
      } as any;

      const rawReceiveAddress = compileScriptRaw({
        configuration,
        data: compilationData,
        scriptId: 'receive_address',
      });
      if (!rawReceiveAddress.success) {
        throw new Error(
          `Failed to compile raw receive_address redeem script: ${JSON.stringify(
            (rawReceiveAddress as any).errors
          )}`
        );
      }

      const generatedUnlock = generateBytecode({
        data: compilationData,
        scriptId: 'schnorr_spend',
      });
      if (!generatedUnlock.success) {
        throw new Error(
          `Failed to compile schnorr_spend unlock: ${JSON.stringify(
            (generatedUnlock as any).errors
          )}`
        );
      }

      const pushInstructions = decodeAuthenticationInstructions(
        generatedUnlock.bytecode
      ) as Array<{ data?: Uint8Array }>;
      const pushes = pushInstructions
        .filter((instruction) => instruction.data !== undefined)
        .map((instruction) => instruction.data as Uint8Array);

      const committedHash = vault.receiveLockingBytecode.slice(2, 34);
      const matchingPush = pushes.find(
        (push) => binToHex(push) === binToHex(rawReceiveAddress.bytecode)
      );

      expect(binToHex(hash256(rawReceiveAddress.bytecode))).toBe(binToHex(committedHash));
      expect(matchingPush).toBeDefined();
    } finally {
      zeroizeQuantumrootArtifacts(vault);
    }
  });

  it('documents that standalone receive_address_token_spend compilation does not match the committed receive root', async () => {
    const vault = await deriveQuantumrootVault(
      Network.CHIPNET,
      TEST_MNEMONIC,
      '',
      0,
      17,
      '0',
      '88'.repeat(32)
    );

    try {
      const compiler = createCompilerBCH(
        walletTemplateToCompilerConfiguration(importedQuantumrootTemplate)
      );
      const configuration = compiler.configuration;
      const compilationData = {
        hdKeys: {
          addressIndex: vault.addressIndex,
          hdPrivateKeys: { owner: vault.accountHdPrivateKey },
        },
        bytecode: {
          leaf_spend_index: '',
          online_quantum_signer: '0',
          quantum_spend_index: '',
          token_spend_index: '',
          vault_token_category: '88'.repeat(32),
        },
        compilationContext: {
          inputIndex: 1,
          sourceOutputs: [
            {
              lockingBytecode: vault.quantumLockLockingBytecode,
              token: {
                category: hexToBin('88'.repeat(32)),
                amount: 1n,
              },
              valueSatoshis: 1000n,
            },
            {
              lockingBytecode: vault.receiveLockingBytecode,
              valueSatoshis: 20_000n,
            },
          ],
          transaction: {
            inputs: [
              {
                outpointIndex: 0,
                outpointTransactionHash: hexToBin('aa'.repeat(31) + '01'),
                sequenceNumber: 0,
                unlockingBytecode: Uint8Array.of(),
              },
              {
                outpointIndex: 1,
                outpointTransactionHash: hexToBin('bb'.repeat(31) + '01'),
                sequenceNumber: 0,
                unlockingBytecode: Uint8Array.of(),
              },
            ],
            locktime: 0,
            outputs: [
              {
                lockingBytecode: vault.quantumLockLockingBytecode,
                token: {
                  category: hexToBin('88'.repeat(32)),
                  amount: 1n,
                },
                valueSatoshis: 1000n,
              },
              {
                lockingBytecode: hexToBin('6a'),
                valueSatoshis: 18_000n,
              },
            ],
            version: 2,
          },
        },
      } as any;

      const rawTokenLeaf = compileScriptRaw({
        configuration,
        data: compilationData,
        scriptId: 'receive_address_token_spend',
      });
      expect(rawTokenLeaf.success).toBe(true);
      if (!rawTokenLeaf.success) {
        throw new Error(
          `Failed to compile raw receive_address_token_spend leaf: ${JSON.stringify(
            (rawTokenLeaf as any).errors
          )}`
        );
      }

      const prefixedTokenLeaf = compileScriptRaw({
        configuration,
        data: {
          ...compilationData,
          bytecode: {
            ...compilationData.bytecode,
            vault_token_category: `0x${'88'.repeat(32)}`,
          },
        },
        scriptId: 'receive_address_token_spend',
      });
      expect(prefixedTokenLeaf.success).toBe(true);
      if (!prefixedTokenLeaf.success) {
        throw new Error(
          `Failed to compile prefixed receive_address_token_spend leaf: ${JSON.stringify(
            (prefixedTokenLeaf as any).errors
          )}`
        );
      }

      const generatedUnlock = compiler.generateBytecode({
        data: compilationData,
        scriptId: 'token_spend',
      });
      expect(generatedUnlock.success).toBe(true);
      if (!generatedUnlock.success) {
        throw new Error(
          `Failed to compile token_spend unlock: ${JSON.stringify(
            (generatedUnlock as any).errors
          )}`
        );
      }

      const pushes = decodeAuthenticationInstructions(generatedUnlock.bytecode).flatMap(
        (instruction) => (instructionHasData(instruction) ? [instruction.data] : [])
      );

      const committedHash = vault.receiveLockingBytecode.slice(2, 34);
      const matchingPush = pushes.find(
        (push) => binToHex(hash256(push)) === binToHex(committedHash)
      );

      expect(disassembleBytecodeBch(generatedUnlock.bytecode)).toContain('OP_PUSHDATA_1');
      expect(binToHex(hash256(rawTokenLeaf.bytecode))).not.toBe(binToHex(committedHash));
      expect(binToHex(hash256(prefixedTokenLeaf.bytecode))).not.toBe(binToHex(committedHash));
      expect(matchingPush).toBeDefined();
    } finally {
      zeroizeQuantumrootArtifacts(vault);
    }
  });

  it('documents that vault_token_category encoding changes the receive_address redeem-script hash', async () => {
    const vault = await deriveQuantumrootVault(
      Network.CHIPNET,
      TEST_MNEMONIC,
      '',
      0,
      13
    );

    try {
      const compiler = createCompilerBCH(
        walletTemplateToCompilerConfiguration(importedQuantumrootTemplate)
      );
      const configuration = compiler.configuration;
      const buildCompilationData = (vaultTokenCategory: string) => ({
        hdKeys: {
          addressIndex: vault.addressIndex,
          hdPrivateKeys: { owner: vault.accountHdPrivateKey },
        },
        bytecode: {
          leaf_spend_index: '0',
          online_quantum_signer: '0',
          quantum_spend_index: '0',
          token_spend_index: '0',
          vault_token_category: vaultTokenCategory,
        },
        compilationContext: {
          inputIndex: 0,
          sourceOutputs: [
            {
              lockingBytecode: vault.receiveLockingBytecode,
              valueSatoshis: 20_000n,
            },
          ],
          transaction: {
            inputs: [
              {
                outpointIndex: 0,
                outpointTransactionHash: hexToBin('00'.repeat(31) + '01'),
                sequenceNumber: 0,
                unlockingBytecode: Uint8Array.of(),
              },
            ],
            locktime: 0,
            outputs: [
              {
                lockingBytecode: hexToBin('6a'),
                valueSatoshis: 19_000n,
              },
            ],
            version: 2,
          },
        },
      } as any);

      const prefixed = compileScriptRaw({
        configuration,
        data: buildCompilationData('0x' + '00'.repeat(32)),
        scriptId: 'receive_address',
      });
      const unprefixed = compileScriptRaw({
        configuration,
        data: buildCompilationData('00'.repeat(32)),
        scriptId: 'receive_address',
      });

      expect(prefixed.success).toBe(true);
      expect(unprefixed.success).toBe(true);
      if (!prefixed.success || !unprefixed.success) {
        throw new Error('Failed to compile receive_address for token-category comparison.');
      }

      const committedHash = binToHex(vault.receiveLockingBytecode.slice(2, 34));

      expect(binToHex(hash256(unprefixed.bytecode))).toBe(committedHash);
      expect(binToHex(hash256(prefixed.bytecode))).not.toBe(committedHash);
    } finally {
      zeroizeQuantumrootArtifacts(vault);
    }
  });

  it('rejects token-carrying receive UTXOs for the minimum recovery flow', async () => {
    const vault = await deriveQuantumrootVault(
      Network.CHIPNET,
      TEST_MNEMONIC,
      '',
      0,
      1
    );

    try {
      const destination = await deriveBchKeyMaterial(
        Network.CHIPNET,
        TEST_MNEMONIC,
        '',
        0,
        0,
        8
      );
      if (!destination) {
        throw new Error('Failed to derive destination address for recovery test.');
      }

      expect(() =>
        buildQuantumrootRecoveryTransaction({
          destinationAddress: destination.address,
          utxo: {
            address: vault.receiveAddress,
            amount: 20_000,
            value: 20_000,
            height: 0,
            tx_hash: '11'.repeat(32),
            tx_pos: 0,
            token: {
              amount: 1,
              category: '22'.repeat(32),
            },
          },
          vault,
        })
      ).toThrow('Quantumroot recovery currently supports BCH-only receive UTXOs.');
    } finally {
      zeroizeQuantumrootArtifacts(vault);
    }
  });

  it('builds a locally verifiable Quantum Lock recovery transaction', async () => {
    const vault = await deriveQuantumrootVault(
      Network.CHIPNET,
      TEST_MNEMONIC,
      '',
      0,
      2
    );
    try {
      const result = buildQuantumrootQuantumLockRecoveryTransaction({
        destinationAddress: vault.receiveAddress,
        utxo: {
          address: vault.quantumLockAddress,
          amount: 25_000,
          value: 25_000,
          height: 0,
          tx_hash: '22'.repeat(31) + '01',
          tx_pos: 1,
        },
        vault,
      });

      expect(result.feeSats).toBeGreaterThan(0n);
      expect(result.recoveryAmountSats).toBe(25_000n - result.feeSats);

      const decoded = decodeTransaction(hexToBin(result.rawTransaction));
      if (typeof decoded === 'string') {
        throw new Error(decoded);
      }

      expect(decoded.inputs).toHaveLength(1);
      expect(decoded.outputs).toHaveLength(1);
      expect(decoded.outputs[0].valueSatoshis).toBe(result.recoveryAmountSats);
    } finally {
      zeroizeQuantumrootArtifacts(vault);
    }
  });

  it('documents that the compiler-generated quantum public key differs from the JS-derived vault quantum public key', async () => {
    const vault = await deriveQuantumrootVault(
      Network.CHIPNET,
      TEST_MNEMONIC,
      '',
      0,
      2
    );
    try {
      const compiler = createCompilerBCH(
        walletTemplateToCompilerConfiguration(importedQuantumrootTemplate)
      );
      const destinationLockingBytecode = hexToBin('76a914010479210471530a214635dfa1bb3ae505d4d49188ac');
      const data = {
        hdKeys: {
          addressIndex: vault.addressIndex,
          hdPrivateKeys: { owner: vault.accountHdPrivateKey },
        },
        bytecode: {
          leaf_spend_index: '0',
          online_quantum_signer: '0',
          quantum_spend_index: '0',
          token_spend_index: '0',
          vault_token_category: '00'.repeat(32),
        },
        compilationContext: {
          inputIndex: 0,
          sourceOutputs: [
            {
              lockingBytecode: vault.quantumLockLockingBytecode,
              valueSatoshis: 25_000n,
            },
          ],
          transaction: {
            version: 2,
            locktime: 0,
            inputs: [
              {
                outpointIndex: 1,
                outpointTransactionHash: hexToBin('22'.repeat(31) + '01'),
                sequenceNumber: 0,
                unlockingBytecode: Uint8Array.of(),
              },
            ],
            outputs: [
              {
                lockingBytecode: destinationLockingBytecode,
                valueSatoshis: 24_750n,
              },
            ],
          },
        },
      } as any;

      assertSuccess(
        compiler.generateBytecode({
          data,
          scriptId: 'quantum_unlock',
        })
      );
      const rawQuantumLockVerifyTransactionShape = compileScriptRaw({
        configuration: compiler.configuration,
        data,
        scriptId: 'quantum_lock_verify_transaction_shape',
      });

      expect(rawQuantumLockVerifyTransactionShape.success).toBe(true);
      if (!rawQuantumLockVerifyTransactionShape.success) {
        throw new Error(
          `Failed to compile raw quantum_lock_verify_transaction_shape: ${JSON.stringify(
            (rawQuantumLockVerifyTransactionShape as any).errors
          )}`
        );
      }
      const compiledQuantumPublicKey = compileScriptRaw({
        configuration: compiler.configuration,
        data,
        scriptId: 'quantum_public_key',
      });

      expect(compiledQuantumPublicKey.success).toBe(true);
      if (!compiledQuantumPublicKey.success) {
        throw new Error(
          `Failed to compile quantum_public_key: ${JSON.stringify(
            (compiledQuantumPublicKey as any).errors
          )}`
        );
      }
      expect(binToHex(compiledQuantumPublicKey.bytecode)).not.toBe(
        binToHex(vault.quantumPublicKey)
      );
    } finally {
      zeroizeQuantumrootArtifacts(vault);
    }
  });

  it('rejects token-carrying Quantum Lock UTXOs for the minimum Quantum Lock recovery flow', async () => {
    const vault = await deriveQuantumrootVault(
      Network.CHIPNET,
      TEST_MNEMONIC,
      '',
      0,
      3
    );

    try {
      const destination = await deriveBchKeyMaterial(
        Network.CHIPNET,
        TEST_MNEMONIC,
        '',
        0,
        0,
        10
      );
      if (!destination) {
        throw new Error('Failed to derive destination address for Quantum Lock recovery test.');
      }

      expect(() =>
        buildQuantumrootQuantumLockRecoveryTransaction({
          destinationAddress: destination.address,
          utxo: {
            address: vault.quantumLockAddress,
            amount: 25_000,
            value: 25_000,
            height: 0,
            tx_hash: '33'.repeat(32),
            tx_pos: 0,
            token: {
              amount: 1,
              category: '44'.repeat(32),
            },
          },
          vault,
        })
      ).toThrow('Quantum Lock recovery currently supports BCH-only Quantum Lock UTXOs.');
    } finally {
      zeroizeQuantumrootArtifacts(vault);
    }
  });
});
