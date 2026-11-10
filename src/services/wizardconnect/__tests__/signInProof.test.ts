import { describe, expect, it, vi } from 'vitest';
import {
  binToHex,
  createVirtualMachineBCH,
  decodeTransaction,
  encodeTransaction,
  hexToBin,
  secp256k1,
  sha256,
  utf8ToBin,
} from '@bitauth/libauth';
import type { SignTransactionRequest } from '@wizardconnect/core';
import { Network } from '../../../state/slices/networkSlice';
import { signConnectorP2pkh } from '../../connect/ConnectSigningCore';
import {
  SignInProofError,
  WIZARDCONNECT_SIGN_IN_SCHEME,
  buildCanonicalSignInProof,
  findClaimedSignInProofSchemeInPayload,
  isSignInProofTransaction,
  p2pkhLockingBytecode,
  signCanonicalSignInProof,
  signInProofAddress,
  signInProofOpReturn,
  signInProofOutpointHash,
  validateSignInProofRequest,
} from '../signInProof';
import {
  signWizardConnectSignInProof,
  signWizardConnectTransaction,
} from '../signing';
import {
  previewWizardSignInProof,
  setSignInProofInspector,
} from '../signInProofPreview';

// Throwaway test key 0x00..07. Never a real wallet key.
const testKey = () => {
  const key = new Uint8Array(32);
  key[31] = 7;
  return key;
};

vi.mock('../derivation', () => ({
  derivePrivateKeyForPath: async () => {
    const key = new Uint8Array(32);
    key[31] = 7;
    return key;
  },
}));

const publicKey = secp256k1.derivePublicKeyCompressed(testKey()) as Uint8Array;
const ownKeys = (path: string, index: number) => {
  if (path !== 'receive' || index !== 3) {
    // Any other path/index is a different address of this wallet.
    return secp256k1.derivePublicKeyCompressed(
      sha256.hash(utf8ToBin(`${path}/${index}`))
    ) as Uint8Array;
  }
  return publicKey;
};

const TEST_CODE = 'Session_abcdef-0123456789';
const lock = () => p2pkhLockingBytecode(publicKey);
const canonical = () => buildCanonicalSignInProof(TEST_CODE, lock());
const TEST_ADDRESS = () =>
  signInProofAddress(
    {
      scheme: WIZARDCONNECT_SIGN_IN_SCHEME,
      code: TEST_CODE,
      path: 'receive',
      addressIndex: 3,
      publicKey,
      lockingBytecode: lock(),
      proof: canonical(),
    },
    'bitcoincash'
  );

const relayJson = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value, (_key, v) =>
      v instanceof Uint8Array
        ? binToHex(v)
        : typeof v === 'bigint'
          ? `<bigint: ${v}n>`
          : v
    )
  );

/** Hex transaction + relay-style source outputs, the common dApp payload. */
function proofRequest() {
  const built = canonical();
  const txHex = binToHex(encodeTransaction(built.transaction));
  return {
    transaction: {
      transaction: txHex,
      sourceOutputs: relayJson(built.sourceOutputs),
      userPrompt: 'WizardConnect sign-in.',
      broadcast: false,
    },
    sequence: 1,
    inputPaths: [[0, 'receive', 3]],
  } as unknown as SignTransactionRequest;
}

function structuredRequest() {
  const built = canonical();
  return {
    built,
    request: {
      transaction: {
        transaction: {
          version: 2,
          locktime: 0,
          inputs: built.transaction.inputs.map((i) => ({ ...i })),
          outputs: built.transaction.outputs.map((o) => ({ ...o })),
        },
        sourceOutputs: built.sourceOutputs.map((s) => ({ ...s })),
        broadcast: false,
      },
      sequence: 1,
      inputPaths: [[0, 'receive', 3]],
    } as unknown as SignTransactionRequest,
  };
}

function withTx(
  mutate: (
    tx: ReturnType<typeof structuredRequest>['built']['transaction'] & {
      sourceOutputs?: unknown;
    }
  ) => void,
  sourceMutate?: (sources: Record<string, unknown>[]) => void
) {
  const { built, request } = structuredRequest();
  const tx = {
    ...built.transaction,
    inputs: built.transaction.inputs.map((i) => ({ ...i })),
    outputs: built.transaction.outputs.map((o) => ({ ...o })),
  };
  mutate(tx);
  const sources = built.sourceOutputs.map((s) => ({ ...s })) as Record<
    string,
    unknown
  >[];
  sourceMutate?.(sources);
  return {
    ...request,
    transaction: {
      ...request.transaction,
      transaction: {
        version: tx.version,
        locktime: tx.locktime,
        inputs: tx.inputs,
        outputs: tx.outputs,
      },
      sourceOutputs: sources,
    },
  } as unknown as SignTransactionRequest;
}

const signWithTestKey = (
  validated: NonNullable<ReturnType<typeof validateSignInProofRequest>>
) =>
  signCanonicalSignInProof(validated, (context, sighash) =>
    signConnectorP2pkh(context as never, testKey(), sighash)
  );

function verifySignedProof(
  signedHex: string,
  sourceOutputs: ReturnType<typeof canonical>['sourceOutputs']
) {
  const signed = decodeTransaction(hexToBin(signedHex));
  if (typeof signed === 'string') throw new Error(signed);
  const vm = createVirtualMachineBCH();
  return vm.verify({ transaction: signed, sourceOutputs });
}

describe('WizardConnect sign-in proof', () => {
  it('builds a canonical WCPROOF with the derived fake outpoint', () => {
    const proof = canonical();
    expect(proof.transaction.version).toBe(2);
    expect(proof.transaction.locktime).toBe(0);
    expect(proof.transaction.inputs).toHaveLength(1);
    expect(proof.transaction.outputs).toHaveLength(2);
    expect(binToHex(proof.transaction.inputs[0].outpointTransactionHash)).toBe(
      binToHex(signInProofOutpointHash(TEST_CODE))
    );
    expect(proof.sourceOutputs[0].valueSatoshis).toBe(1000n);
    expect(binToHex(proof.transaction.outputs[0].lockingBytecode)).toBe(
      binToHex(signInProofOpReturn(TEST_CODE))
    );
  });

  it('accepts a hex WCPROOF request and signs a proof the VM accepts', () => {
    const validated = validateSignInProofRequest(proofRequest(), ownKeys);
    expect(validated).not.toBeNull();
    expect(validated!.scheme.id).toBe('wizardconnect-generic');
    expect(validated!.scheme.label).toBe('WizardConnect sign-in');
    expect(validated!.code).toBe(TEST_CODE);
    expect(signInProofAddress(validated!, 'bitcoincash')).toBe(TEST_ADDRESS());

    const signedHex = signWithTestKey(validated!);
    const signed = decodeTransaction(hexToBin(signedHex));
    if (typeof signed === 'string') throw new Error(signed);
    // SIGHASH_ALL|UTXOS|FORKID
    expect(signed.inputs[0].unlockingBytecode[65]).toBe(0x61);
    expect(verifySignedProof(signedHex, validated!.proof.sourceOutputs)).toBe(
      true
    );
    expect(isSignInProofTransaction(signedHex)).toBe(true);
  });

  it('signs through the wallet signing path with the canonical tx only', async () => {
    const validated = validateSignInProofRequest(proofRequest(), ownKeys)!;
    const signedHex = await signWizardConnectSignInProof(validated, {
      mnemonic: 'mocked test key',
      passphrase: '',
      network: Network.MAINNET,
    });
    expect(verifySignedProof(signedHex, validated.proof.sourceOutputs)).toBe(
      true
    );
  });

  it('accepts the structured (object) form too', () => {
    expect(
      validateSignInProofRequest(structuredRequest().request, ownKeys)
    ).not.toBeNull();
  });

  it('ignores ordinary transactions', () => {
    const request = withTx((tx) => {
      tx.outputs[0] = {
        lockingBytecode: Uint8Array.from([0x6a, 0x03, 0x41, 0x42, 0x43]),
        valueSatoshis: 0n,
      };
    });
    expect(validateSignInProofRequest(request, ownKeys)).toBeNull();
  });

  it('does not treat a BSEDITOR tag as a sign-in proof', () => {
    const request = withTx((tx) => {
      const code = utf8ToBin('0123456789abcdef0123456789abcdef');
      const tag = utf8ToBin('BSEDITOR');
      tx.outputs[0] = {
        lockingBytecode: Uint8Array.from([
          0x6a,
          tag.length,
          ...tag,
          code.length,
          ...code,
        ]),
        valueSatoshis: 0n,
      };
    });
    expect(validateSignInProofRequest(request, ownKeys)).toBeNull();
    expect(
      findClaimedSignInProofSchemeInPayload(request.transaction)
    ).toBeNull();
  });

  const refusals: [string, () => SignTransactionRequest][] = [
    [
      'an extra real input',
      () =>
        withTx(
          (tx) => {
            tx.inputs.push({
              ...tx.inputs[0],
              outpointTransactionHash: new Uint8Array(32).fill(9),
            });
          },
          (sources) => {
            sources.push({
              ...sources[0],
              outpointTransactionHash: new Uint8Array(32).fill(9),
            });
          }
        ),
    ],
    [
      'a real outpoint instead of the derived one',
      () =>
        withTx((tx) => {
          tx.inputs[0] = {
            ...tx.inputs[0],
            outpointTransactionHash: new Uint8Array(32).fill(1),
          };
        }),
    ],
    [
      'a non-zero outpoint index',
      () =>
        withTx((tx) => {
          tx.inputs[0] = { ...tx.inputs[0], outpointIndex: 1 };
        }),
    ],
    [
      'a tampered output value',
      () =>
        withTx((tx) => {
          tx.outputs[1] = { ...tx.outputs[1], valueSatoshis: 999n };
        }),
    ],
    [
      'output 1 paying a different address',
      () =>
        withTx((tx) => {
          tx.outputs[1] = {
            ...tx.outputs[1],
            lockingBytecode: hexToBin(
              '76a914000000000000000000000000000000000000000088ac'
            ),
          };
        }),
    ],
    [
      'an extra output',
      () =>
        withTx((tx) => {
          tx.outputs.push({ ...tx.outputs[1], valueSatoshis: 0n });
        }),
    ],
    [
      'token data on an output',
      () =>
        withTx((tx) => {
          (tx.outputs[1] as Record<string, unknown>).token = {
            category: new Uint8Array(32).fill(4),
            amount: 1n,
          };
        }),
    ],
    [
      'token data on the source output',
      () =>
        withTx(
          () => {},
          (sources) => {
            sources[0].token = {
              category: new Uint8Array(32).fill(4),
              amount: 1n,
            };
          }
        ),
    ],
    [
      'a bigger source value',
      () =>
        withTx(
          () => {},
          (sources) => {
            sources[0].valueSatoshis = 100000n;
          }
        ),
    ],
    [
      'a different version',
      () =>
        withTx((tx) => {
          tx.version = 1;
        }),
    ],
    [
      'a non-zero locktime',
      () =>
        withTx((tx) => {
          tx.locktime = 5;
        }),
    ],
    [
      'a malformed code',
      () => {
        const badCode = 'too short';
        const lockingBytecode = lock();
        const input = {
          outpointTransactionHash: signInProofOutpointHash(badCode),
          outpointIndex: 0,
          sequenceNumber: 0xffffffff,
          unlockingBytecode: new Uint8Array(0),
        };
        return {
          transaction: {
            transaction: {
              version: 2,
              locktime: 0,
              inputs: [{ ...input }],
              outputs: [
                {
                  lockingBytecode: signInProofOpReturn(badCode),
                  valueSatoshis: 0n,
                },
                {
                  lockingBytecode,
                  valueSatoshis: 1000n,
                },
              ],
            },
            sourceOutputs: [
              {
                ...input,
                lockingBytecode,
                valueSatoshis: 1000n,
              },
            ],
          },
          inputPaths: [[0, 'receive', 3]],
        } as unknown as SignTransactionRequest;
      },
    ],
    [
      'an address that is not the one at the requested path',
      () =>
        ({
          ...proofRequest(),
          inputPaths: [[0, 'receive', 4]],
        }) as unknown as SignTransactionRequest,
    ],
    [
      'a second input path',
      () =>
        ({
          ...proofRequest(),
          inputPaths: [
            [0, 'receive', 3],
            [1, 'receive', 3],
          ],
        }) as unknown as SignTransactionRequest,
    ],
    [
      'broadcast: true',
      () => {
        const request = proofRequest();
        return {
          ...request,
          transaction: { ...request.transaction, broadcast: true },
        } as SignTransactionRequest;
      },
    ],
  ];

  it.each(refusals)('refuses %s', (_label, make) => {
    expect(() => validateSignInProofRequest(make(), ownKeys)).toThrow(
      SignInProofError
    );
  });

  it('never signs a tagged request as a payment', async () => {
    for (const request of [proofRequest(), refusals[0][1]()]) {
      await expect(
        signWizardConnectTransaction(request, {
          mnemonic: 'mocked test key',
          passphrase: '',
          network: Network.MAINNET,
        })
      ).rejects.toThrow(SignInProofError);
    }
  });

  it('detects the claim in both hex and structured payloads', () => {
    expect(
      findClaimedSignInProofSchemeInPayload(proofRequest().transaction)?.id
    ).toBe('wizardconnect-generic');
    expect(
      findClaimedSignInProofSchemeInPayload(
        structuredRequest().request.transaction
      )?.id
    ).toBe('wizardconnect-generic');
  });

  it('flags proofs for the broadcast guard but not ordinary transactions', () => {
    expect(
      isSignInProofTransaction(encodeTransaction(canonical().transaction))
    ).toBe(true);
    const ordinary = canonical();
    const real = encodeTransaction({
      ...ordinary.transaction,
      inputs: [
        {
          ...ordinary.transaction.inputs[0],
          outpointTransactionHash: new Uint8Array(32).fill(1),
        },
      ],
    });
    expect(isSignInProofTransaction(real)).toBe(false);
    expect(isSignInProofTransaction('zz')).toBe(false);
  });

  it('previews proofs for the approval screen from the wallet, not the dapp', () => {
    setSignInProofInspector(null);
    expect(previewWizardSignInProof(proofRequest()).kind).toBe('invalid');
    setSignInProofInspector({
      network: Network.MAINNET,
      inspectSignInProof: (request) =>
        validateSignInProofRequest(request, ownKeys),
    });
    expect(previewWizardSignInProof(proofRequest())).toEqual({
      kind: 'proof',
      schemeId: 'wizardconnect-generic',
      schemeLabel: 'WizardConnect sign-in',
      code: TEST_CODE,
      address: TEST_ADDRESS(),
    });
    expect(previewWizardSignInProof(refusals[3][1]())).toMatchObject({
      kind: 'invalid',
    });
    expect(
      previewWizardSignInProof(
        withTx((tx) => {
          tx.outputs[0] = {
            lockingBytecode: Uint8Array.from([0x6a]),
            valueSatoshis: 0n,
          };
        })
      )
    ).toEqual({ kind: 'none' });
    setSignInProofInspector(null);
  });
});
