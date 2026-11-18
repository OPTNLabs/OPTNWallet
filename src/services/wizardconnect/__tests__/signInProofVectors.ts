// test-vectors/wizardconnect-sign-in-proof.json is read by BOTH sides: the
// Rust core's own tests (crates/optn-core/src/sign_in_proof.rs) and the
// TypeScript glue tests next to this file. The requests in it are in the
// shape the core takes; this turns them back into what a dApp sends, so the
// glue is exercised on the way in.
import {
  decodeTransaction,
  deriveHdPath,
  deriveHdPrivateNodeFromBip39Mnemonic,
  hexToBin,
} from '@bitauth/libauth';
import type { SignTransactionRequest } from '@wizardconnect/core';
import vectors from '../../../../test-vectors/wizardconnect-sign-in-proof.json';
import { Network } from '../../../state/slices/networkSlice';
import type { SignInProofWallet } from '../signInProof';

export { vectors };

export type CoreRequest = (typeof vectors.refusals)[number]['request'];
export type ProofVector = (typeof vectors.proofs)[number];

/** `hex` is raw hex plus relay-encoded values; `structured` is SDK objects. */
export type RequestForm = 'hex' | 'structured';
export const REQUEST_FORMS: RequestForm[] = ['hex', 'structured'];

export function vectorWallet(network = Network.MAINNET): SignInProofWallet {
  return { network, xpubs: vectors.wallet.xpubs };
}

/** The seed material the wallet adapter signs with. A public test mnemonic. */
export function vectorSeed(network = Network.MAINNET) {
  return {
    mnemonic: vectors.wallet.mnemonic,
    passphrase: '',
    network,
    accountPath: vectors.wallet.accountPath,
  };
}

/** A key derived by libauth, independently of the Rust core. */
export function libauthPrivateKey(derivationPath: string): Uint8Array {
  return deriveHdPath(
    deriveHdPrivateNodeFromBip39Mnemonic(vectors.wallet.mnemonic),
    derivationPath
  ).privateKey;
}

const tokenCategory = '04'.repeat(32);

export function sdkRequest(
  core: CoreRequest,
  form: RequestForm = 'hex'
): SignTransactionRequest {
  const relay = form === 'hex';
  const bytes = (hex: string) =>
    relay ? `<Uint8Array: 0x${hex}>` : hexToBin(hex);
  const amount = (value: string) =>
    relay ? `<bigint: ${value}n>` : BigInt(value);
  let transaction: unknown = core.transaction;
  if (!relay) {
    transaction = decodeTransaction(hexToBin(core.transaction));
    if (typeof transaction === 'string') throw new Error(transaction);
  }
  return {
    transaction: {
      transaction,
      sourceOutputs: core.sourceOutputs.map((source) => ({
        valueSatoshis: amount(source.valueSatoshis),
        lockingBytecode: bytes(source.lockingBytecode),
        unlockingBytecode: bytes(source.unlockingBytecode),
        ...(source.token
          ? { token: { category: bytes(tokenCategory), amount: amount('1') } }
          : {}),
        ...(source.contract
          ? {
              contract: {
                abiFunction: { name: 'spend', inputs: [] },
                redeemScript: bytes('51'),
                artifact: { contractName: 'Vault' },
              },
            }
          : {}),
      })),
      broadcast: core.broadcast,
    },
    sequence: 1,
    inputPaths: core.inputPaths,
  } as unknown as SignTransactionRequest;
}

/** The canonical request for a proof vector, as the core takes it. */
export function proofCoreRequest(proof: ProofVector): CoreRequest {
  return {
    transaction: proof.unsigned,
    sourceOutputs: [
      {
        valueSatoshis: vectors.format.valueSatoshis,
        lockingBytecode: proof.lockingBytecode,
        token: false,
        contract: false,
        unlockingBytecode: '',
      },
    ],
    inputPaths: [[0, proof.path, proof.addressIndex]],
    broadcast: false,
  };
}

export function proofRequest(
  proof: ProofVector = vectors.proofs[0],
  form: RequestForm = 'hex'
): SignTransactionRequest {
  return sdkRequest(proofCoreRequest(proof), form);
}

export function refusalNamed(name: string) {
  const found = vectors.refusals.find((refusal) => refusal.name === name);
  if (!found) throw new Error(`no refusal vector named ${name}`);
  return found;
}
