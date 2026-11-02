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
  BADGER_SURVIVORS_EDITOR_SCHEME,
  GENERIC_WIZARDCONNECT_SCHEME,
  SignInProofError,
  buildCanonicalSignInProof,
  findClaimedSignInProofSchemeInPayload,
  isSignInProofTransaction,
  p2pkhLockingBytecode,
  registerSignInProofScheme,
  signCanonicalSignInProof,
  signInProofAddress,
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
import {
  BS_GOLDEN,
  buildChallengeTx,
  verifyChallengeTx,
} from './fixtures/badgerSurvivorsChallenge';

// Throwaway test key 0x00..07. Never a real wallet key.
const testKey = () => {
  const key = new Uint8Array(32);
  key[31] = BS_GOLDEN.privateKeyByte;
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

/** The request exactly as Badger Survivors v0.545 sends it: hex tx + relay source outputs. */
function bsRequest(
  overrides: Partial<{ nonce: string; address: string }> = {}
) {
  const built = buildChallengeTx(
    overrides.nonce ?? BS_GOLDEN.nonce,
    overrides.address ?? BS_GOLDEN.address
  )!;
  const txHex = binToHex(
    encodeTransaction({
      version: built.version,
      locktime: built.locktime,
      inputs: built.inputs,
      outputs: built.outputs,
    })
  );
  return {
    transaction: {
      transaction: txHex,
      sourceOutputs: relayJson(built.sourceOutputs),
      userPrompt: 'Badger Survivors editor sign-in.',
      broadcast: false,
    },
    sequence: 1,
    inputPaths: [[0, 'receive', 3]],
  } as unknown as SignTransactionRequest;
}

function structuredRequest() {
  const built = buildChallengeTx(BS_GOLDEN.nonce, BS_GOLDEN.address)!;
  return {
    built,
    request: {
      transaction: {
        transaction: {
          version: 2,
          locktime: 0,
          inputs: built.inputs.map((i) => ({ ...i })),
          outputs: built.outputs.map((o) => ({ ...o })),
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
  mutate: (tx: ReturnType<typeof structuredRequest>['built']) => void,
  sourceMutate?: (sources: Record<string, unknown>[]) => void
) {
  const { built, request } = structuredRequest();
  mutate(built);
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
        version: built.version,
        locktime: built.locktime,
        inputs: built.inputs,
        outputs: built.outputs,
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

describe('WizardConnect sign-in proof', () => {
  it('builds the canonical proof byte-identical to Badger Survivors buildChallengeTx', () => {
    expect(binToHex(publicKey)).toBe(BS_GOLDEN.publicKey);
    const lock = p2pkhLockingBytecode(publicKey);
    expect(binToHex(lock)).toBe(BS_GOLDEN.lockingBytecode);
    const proof = buildCanonicalSignInProof(
      BADGER_SURVIVORS_EDITOR_SCHEME,
      BS_GOLDEN.nonce,
      lock
    );
    expect(binToHex(encodeTransaction(proof.transaction))).toBe(
      BS_GOLDEN.unsignedHex
    );
    expect(binToHex(proof.sourceOutputs[0].outpointTransactionHash)).toBe(
      BS_GOLDEN.outpointHash
    );
    expect(proof.sourceOutputs[0].valueSatoshis).toBe(1000n);
  });

  it('accepts the exact BS v0.545 request and signs a proof the BS verifier accepts', () => {
    const validated = validateSignInProofRequest(bsRequest(), ownKeys);
    expect(validated).not.toBeNull();
    expect(validated!.scheme.id).toBe('badgersurvivors-editor');
    expect(validated!.code).toBe(BS_GOLDEN.nonce);
    expect(signInProofAddress(validated!, 'bitcoincash')).toBe(
      BS_GOLDEN.address
    );

    const signedHex = signWithTestKey(validated!);
    const signed = decodeTransaction(hexToBin(signedHex));
    if (typeof signed === 'string') throw new Error(signed);
    // SIGHASH_ALL|UTXOS|FORKID
    expect(signed.inputs[0].unlockingBytecode[65]).toBe(0x61);

    const vm = createVirtualMachineBCH();
    expect(
      vm.verify({
        transaction: signed,
        sourceOutputs: validated!.proof.sourceOutputs,
      })
    ).toBe(true);
    expect(
      verifyChallengeTx(vm, {
        signedTransaction: signedHex,
        nonce: BS_GOLDEN.nonce,
        address: BS_GOLDEN.address,
      })
    ).toEqual({ ok: true });
    // A different nonce or address fails server-side verification.
    expect(
      verifyChallengeTx(vm, {
        signedTransaction: signedHex,
        nonce: 'f'.repeat(32),
        address: BS_GOLDEN.address,
      }).ok
    ).toBe(false);
    expect(isSignInProofTransaction(signedHex)).toBe(true);
  });

  it('signs through the wallet signing path with the canonical tx only', async () => {
    const validated = validateSignInProofRequest(bsRequest(), ownKeys)!;
    const signedHex = await signWizardConnectSignInProof(validated, {
      mnemonic: 'mocked test key',
      passphrase: '',
      network: Network.MAINNET,
    });
    expect(
      verifyChallengeTx(createVirtualMachineBCH(), {
        signedTransaction: signedHex,
        nonce: BS_GOLDEN.nonce,
        address: BS_GOLDEN.address,
      })
    ).toEqual({ ok: true });
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
        const nonce = 'ABCDEF0123456789abcdef0123456789';
        const lock = p2pkhLockingBytecode(publicKey);
        const proof = buildCanonicalSignInProof(
          { ...BADGER_SURVIVORS_EDITOR_SCHEME, codePattern: /^.*$/ },
          nonce,
          lock
        );
        return {
          transaction: {
            transaction: proof.transaction,
            sourceOutputs: proof.sourceOutputs,
          },
          inputPaths: [[0, 'receive', 3]],
        } as unknown as SignTransactionRequest;
      },
    ],
    [
      'an address that is not the one at the requested path',
      () =>
        ({
          ...bsRequest(),
          inputPaths: [[0, 'receive', 4]],
        }) as unknown as SignTransactionRequest,
    ],
    [
      'a second input path',
      () =>
        ({
          ...bsRequest(),
          inputPaths: [
            [0, 'receive', 3],
            [1, 'receive', 3],
          ],
        }) as unknown as SignTransactionRequest,
    ],
    [
      'broadcast: true',
      () => {
        const request = bsRequest();
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
    for (const request of [bsRequest(), refusals[0][1]()]) {
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
      findClaimedSignInProofSchemeInPayload(bsRequest().transaction)?.id
    ).toBe('badgersurvivors-editor');
    expect(
      findClaimedSignInProofSchemeInPayload(
        structuredRequest().request.transaction
      )?.id
    ).toBe('badgersurvivors-editor');
  });

  it('supports the generic marker and new registered schemes', () => {
    const code = 'Session_abcdef-0123456789';
    const lock = p2pkhLockingBytecode(publicKey);
    const generic = buildCanonicalSignInProof(
      GENERIC_WIZARDCONNECT_SCHEME,
      code,
      lock
    );
    const request = {
      transaction: {
        transaction: generic.transaction,
        sourceOutputs: generic.sourceOutputs,
      },
      inputPaths: [[0, 'receive', 3]],
    } as unknown as SignTransactionRequest;
    const validated = validateSignInProofRequest(request, ownKeys)!;
    expect(validated.scheme.id).toBe('wizardconnect-generic');
    expect(isSignInProofTransaction(signWithTestKey(validated))).toBe(true);

    registerSignInProofScheme({
      id: 'example-test',
      label: 'Example',
      opReturnTag: 'EXTEST',
      outpointTag: 'Example test:',
      valueSatoshis: 546n,
      codePattern: /^[0-9]{8}$/,
    });
    expect(() =>
      registerSignInProofScheme({ ...GENERIC_WIZARDCONNECT_SCHEME, id: 'dupe' })
    ).toThrow();
  });

  it('flags proofs for the broadcast guard but not ordinary transactions', () => {
    expect(isSignInProofTransaction(BS_GOLDEN.unsignedHex)).toBe(true);
    const ordinary = buildChallengeTx(BS_GOLDEN.nonce, BS_GOLDEN.address)!;
    const real = encodeTransaction({
      version: 2,
      locktime: 0,
      inputs: [
        {
          ...ordinary.inputs[0],
          outpointTransactionHash: new Uint8Array(32).fill(1),
        },
      ],
      outputs: ordinary.outputs,
    });
    expect(isSignInProofTransaction(real)).toBe(false);
    expect(isSignInProofTransaction('zz')).toBe(false);
  });

  it('previews proofs for the approval screen from the wallet, not the dapp', () => {
    setSignInProofInspector(null);
    expect(previewWizardSignInProof(bsRequest()).kind).toBe('invalid');
    setSignInProofInspector({
      network: Network.MAINNET,
      inspectSignInProof: (request) =>
        validateSignInProofRequest(request, ownKeys),
    });
    expect(previewWizardSignInProof(bsRequest())).toEqual({
      kind: 'proof',
      schemeId: 'badgersurvivors-editor',
      schemeLabel: 'Badger Survivors editor',
      code: BS_GOLDEN.nonce,
      address: BS_GOLDEN.address,
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
