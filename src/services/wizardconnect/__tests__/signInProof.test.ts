import { describe, expect, it } from 'vitest';
import {
  createVirtualMachineBCH,
  decodeTransaction,
  hexToBin,
} from '@bitauth/libauth';
import type { SignTransactionRequest } from '@wizardconnect/core';
import { Network } from '../../../state/slices/networkSlice';
import {
  SignInProofError,
  findClaimedSignInProofSchemeInPayload,
  isSignInProofTransaction,
  signCanonicalSignInProof,
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
  REQUEST_FORMS,
  libauthPrivateKey,
  proofRequest,
  refusalNamed,
  sdkRequest,
  vectorSeed,
  vectorWallet,
  vectors,
  type ProofVector,
} from './signInProofVectors';

const wallet = vectorWallet();
const validate = (request: SignTransactionRequest) =>
  validateSignInProofRequest(request, wallet);

/**
 * The BCH VM's own verdict on a signed proof: an oracle outside the core.
 * `standard` adds relay policy, which a proof never has to meet.
 */
function vmAccepts(signedHex: string, proof: ProofVector, standard: boolean) {
  const signed = decodeTransaction(hexToBin(signedHex));
  if (typeof signed === 'string') throw new Error(signed);
  return createVirtualMachineBCH(standard).verify({
    transaction: signed,
    sourceOutputs: [
      {
        lockingBytecode: hexToBin(proof.lockingBytecode),
        valueSatoshis: BigInt(vectors.format.valueSatoshis),
      },
    ],
  });
}

describe('WizardConnect sign-in proof glue over the shared Rust core', () => {
  describe.each(REQUEST_FORMS)('a %s request', (form) => {
    it.each(vectors.proofs)(
      'is validated to the wallet’s own address: $name',
      (proof) => {
        const request = proofRequest(proof, form);
        expect(
          findClaimedSignInProofSchemeInPayload(request.transaction)?.id
        ).toBe('wizardconnect-generic');
        const validated = validate(request);
        expect(validated).toMatchObject({
          scheme: {
            id: 'wizardconnect-generic',
            label: 'WizardConnect sign-in',
          },
          code: proof.code,
          domain: proof.domain,
          path: proof.path,
          addressIndex: proof.addressIndex,
          address: proof.addresses.mainnet,
        });
        expect(validated!.publicKey).toEqual(hexToBin(proof.publicKey));
      }
    );

    it.each(vectors.refusals)('is refused: $name', (refusal) => {
      const request = sdkRequest(refusal.request, form);
      expect(
        findClaimedSignInProofSchemeInPayload(request.transaction)
      ).not.toBeNull();
      let thrown: unknown;
      try {
        validate(request);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(SignInProofError);
      expect((thrown as Error).message).toBe(
        `WizardConnect sign-in proof refused: ${refusal.reason}`
      );
    });

    it.each(vectors.unclaimed)('is not a proof at all: $name', (unclaimed) => {
      const request = sdkRequest(unclaimed.request, form);
      expect(
        findClaimedSignInProofSchemeInPayload(request.transaction)
      ).toBeNull();
      expect(validate(request)).toBeNull();
    });
  });

  it('names the address under the wallet’s own network', () => {
    const proof = vectors.proofs[0];
    expect(
      validateSignInProofRequest(
        proofRequest(proof),
        vectorWallet(Network.CHIPNET)
      )?.address
    ).toBe(proof.addresses.chipnet);
  });

  it.each(vectors.proofs)(
    'signs the reference proof through the wallet signing path: $name',
    async (proof) => {
      const validated = validate(proofRequest(proof))!;
      const signedHex = await signWizardConnectSignInProof(
        validated,
        vectorSeed()
      );
      expect(signedHex).toBe(proof.signed);
      const signed = decodeTransaction(hexToBin(signedHex));
      if (typeof signed === 'string') throw new Error(signed);
      // SIGHASH_ALL|UTXOS|FORKID
      expect(signed.inputs[0].unlockingBytecode[65]).toBe(
        vectors.format.sighash
      );
      expect(vmAccepts(signedHex, proof, false)).toBe(true);
      expect(vmAccepts(signedHex, proof, true) === true).toBe(proof.standard);
      expect(isSignInProofTransaction(signedHex)).toBe(true);
    }
  );

  it('signs with a key libauth derived, and with no other', () => {
    const [proof, other] = vectors.proofs;
    const validated = validate(proofRequest(proof))!;
    expect(
      signCanonicalSignInProof(
        validated,
        libauthPrivateKey(proof.derivationPath)
      )
    ).toBe(proof.signed);
    expect(() =>
      signCanonicalSignInProof(
        validated,
        libauthPrivateKey(other.derivationPath)
      )
    ).toThrow(SignInProofError);
  });

  it('turns SDK values the wallet cannot decode into refusals', () => {
    const withSources = (sourceOutputs: unknown) => {
      const request = proofRequest();
      return {
        ...request,
        transaction: { ...request.transaction, sourceOutputs },
      } as unknown as SignTransactionRequest;
    };
    const [source] = proofRequest().transaction
      .sourceOutputs as unknown as Record<string, unknown>[];
    for (const request of [
      withSources([{ ...source, valueSatoshis: 'not a number' }]),
      withSources([{ ...source, lockingBytecode: 'not bytes' }]),
      withSources([]),
    ]) {
      expect(() => validate(request)).toThrow(SignInProofError);
    }
    for (const inputPaths of [
      [[0, 'receive', -1]],
      [[0, 'receive', 1.5]],
      [[0, 7, 3]],
      [['0', 'receive', 3]],
      'receive',
    ]) {
      expect(() =>
        validate({
          ...proofRequest(),
          inputPaths,
        } as unknown as SignTransactionRequest)
      ).toThrow('WizardConnect sign-in proof refused: malformed request');
    }
  });

  it('never signs a tagged request as a payment', async () => {
    for (const request of [
      proofRequest(),
      sdkRequest(refusalNamed('an extra real input').request),
    ]) {
      await expect(
        signWizardConnectTransaction(request, vectorSeed())
      ).rejects.toThrow(SignInProofError);
    }
  });

  it.each(vectors.broadcastGuard)(
    'flags what the broadcast guard must stop: $name',
    (guard) => {
      expect(isSignInProofTransaction(guard.transaction)).toBe(
        guard.signInProof
      );
      expect(isSignInProofTransaction(hexToBin(guard.transaction))).toBe(
        guard.signInProof
      );
    }
  );

  it('does not flag bytes that are no transaction', () => {
    for (const raw of ['zz', '', '00', vectors.proofs[0].unsigned + '00']) {
      expect(isSignInProofTransaction(raw)).toBe(false);
    }
  });

  it('previews proofs for the approval screen from the wallet, not the dapp', () => {
    const proof = vectors.proofs[0];
    setSignInProofInspector(null);
    expect(previewWizardSignInProof(proofRequest(proof)).kind).toBe('invalid');
    setSignInProofInspector({ inspectSignInProof: validate });
    expect(previewWizardSignInProof(proofRequest(proof))).toEqual({
      kind: 'proof',
      schemeId: 'wizardconnect-generic',
      schemeLabel: 'WizardConnect sign-in',
      domain: proof.domain,
      code: proof.code,
      address: proof.addresses.mainnet,
    });
    const tampered = refusalNamed('a tampered output value');
    expect(previewWizardSignInProof(sdkRequest(tampered.request))).toEqual({
      kind: 'invalid',
      message: `WizardConnect sign-in proof refused: ${tampered.reason}`,
    });
    const untagged = vectors.unclaimed.find(
      (unclaimed) => unclaimed.name === 'a bare OP_RETURN'
    )!;
    expect(previewWizardSignInProof(sdkRequest(untagged.request))).toEqual({
      kind: 'none',
    });
    setSignInProofInspector(null);
  });
});
