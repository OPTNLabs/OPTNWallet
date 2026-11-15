// Cross-check of the Rust sign-in proof core against @bitauth/libauth.
//
// For every proof in test-vectors/wizardconnect-sign-in-proof.json, libauth
// rebuilds the canonical transaction from the vector's fields alone (the code,
// the relying party's domain and the proven address), signs it itself, and
// runs its BCH VM. The Rust
// core, through the committed WASM, must accept libauth's bytes as its own
// canonical proof and must sign them to exactly libauth's signed bytes.
//
// The Rust tests check the same vector file natively, so a disagreement on
// either side turns CI red.
import { describe, expect, it } from 'vitest';
import {
  binToHex,
  createVirtualMachineBCH,
  decodeTransaction,
  encodeDataPush,
  encodeTransaction,
  generateSigningSerializationBCH,
  hash256,
  hexToBin,
  secp256k1,
  sha256,
  utf8ToBin,
  type CompilationContextBCH,
  type Transaction,
} from '@bitauth/libauth';
import {
  signCanonicalSignInProof,
  validateSignInProofRequest,
} from '../signInProof';
import {
  libauthPrivateKey,
  proofCoreRequest,
  sdkRequest,
  vectorWallet,
  vectors,
  type ProofVector,
} from './signInProofVectors';

const { format } = vectors;
const OP_RETURN = 0x6a;

/** What the proof states after the tag, and what its outpoint hashes. */
function statement(proof: ProofVector) {
  return {
    pushes: [utf8ToBin(proof.code), utf8ToBin(proof.domain)],
    outpointPreimage: utf8ToBin(
      `${format.outpointTag}${proof.code}${format.outpointSeparator}${proof.domain}`
    ),
  };
}

/** The canonical proof, built from the vector's fields by libauth alone. */
function libauthCanonical(proof: ProofVector) {
  const { pushes, outpointPreimage } = statement(proof);
  const lockingBytecode = hexToBin(proof.lockingBytecode);
  const valueSatoshis = BigInt(format.valueSatoshis);
  const transaction: Transaction = {
    version: format.version,
    locktime: format.locktime,
    inputs: [
      {
        outpointTransactionHash: sha256.hash(outpointPreimage),
        outpointIndex: 0,
        sequenceNumber: format.sequenceNumber,
        unlockingBytecode: new Uint8Array(0),
      },
    ],
    outputs: [
      {
        lockingBytecode: Uint8Array.from([
          OP_RETURN,
          ...encodeDataPush(utf8ToBin(format.opReturnTag)),
          ...pushes.flatMap((data) => [...encodeDataPush(data)]),
        ]),
        valueSatoshis: 0n,
      },
      { lockingBytecode, valueSatoshis },
    ],
  };
  return {
    transaction,
    sourceOutputs: [{ lockingBytecode, valueSatoshis }],
  };
}

/** libauth's own BCH Schnorr signature over its own signing serialization. */
function libauthSigned(proof: ProofVector): Uint8Array {
  const { transaction, sourceOutputs } = libauthCanonical(proof);
  const privateKey = libauthPrivateKey(proof.derivationPath);
  const publicKey = secp256k1.derivePublicKeyCompressed(privateKey);
  if (typeof publicKey === 'string') throw new Error(publicKey);
  const serialization = generateSigningSerializationBCH(
    { inputIndex: 0, sourceOutputs, transaction } as CompilationContextBCH,
    {
      coveredBytecode: sourceOutputs[0].lockingBytecode,
      signingSerializationType: Uint8Array.of(format.sighash),
    }
  );
  const signature = secp256k1.signMessageHashSchnorr(
    privateKey,
    hash256(serialization)
  );
  if (typeof signature === 'string') throw new Error(signature);
  return encodeTransaction({
    ...transaction,
    inputs: [
      {
        ...transaction.inputs[0],
        unlockingBytecode: Uint8Array.from([
          ...encodeDataPush(Uint8Array.from([...signature, format.sighash])),
          ...encodeDataPush(publicKey),
        ]),
      },
    ],
  });
}

/** libauth's BCH VM, under consensus rules or with relay policy too. */
function libauthVerifies(
  signed: Uint8Array,
  proof: ProofVector,
  standard: boolean
) {
  const transaction = decodeTransaction(signed);
  if (typeof transaction === 'string') throw new Error(transaction);
  return createVirtualMachineBCH(standard).verify({
    transaction,
    sourceOutputs: libauthCanonical(proof).sourceOutputs,
  });
}

describe.each(vectors.proofs)(
  'libauth and the Rust core agree: $name',
  (proof) => {
    const unsigned = encodeTransaction(libauthCanonical(proof).transaction);

    it('libauth builds the unsigned bytes the Rust tests expect', () => {
      expect(binToHex(unsigned)).toBe(proof.unsigned);
    });

    it('the Rust core accepts libauth’s bytes as its own canonical proof', () => {
      const request = sdkRequest({
        ...proofCoreRequest(proof),
        transaction: binToHex(unsigned),
      });
      const validated = validateSignInProofRequest(request, vectorWallet());
      expect(validated).toMatchObject({
        code: proof.code,
        domain: proof.domain,
        path: proof.path,
        addressIndex: proof.addressIndex,
      });
    });

    it('the Rust core signs to exactly libauth’s signed bytes, which libauth’s VM accepts', () => {
      const validated = validateSignInProofRequest(
        sdkRequest({
          ...proofCoreRequest(proof),
          transaction: binToHex(unsigned),
        }),
        vectorWallet()
      )!;
      const rustSigned = hexToBin(
        signCanonicalSignInProof(
          validated,
          libauthPrivateKey(proof.derivationPath)
        )
      );
      const expected = libauthSigned(proof);
      expect(binToHex(rustSigned)).toBe(binToHex(expected));
      expect(binToHex(rustSigned)).toBe(proof.signed);

      // Without its unlocking script, the Rust-signed proof is libauth's
      // canonical transaction byte for byte.
      const decoded = decodeTransaction(rustSigned);
      if (typeof decoded === 'string') throw new Error(decoded);
      decoded.inputs[0].unlockingBytecode = new Uint8Array(0);
      expect(binToHex(encodeTransaction(decoded))).toBe(binToHex(unsigned));

      expect(libauthVerifies(rustSigned, proof, false)).toBe(true);
      // A proof is never relayed. A long domain can take it past the relay
      // limit on data carriers; the vector says which.
      expect(libauthVerifies(rustSigned, proof, true) === true).toBe(
        proof.standard
      );
    });
  }
);
