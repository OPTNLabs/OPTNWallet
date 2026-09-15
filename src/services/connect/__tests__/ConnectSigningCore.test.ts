import { describe, expect, it } from 'vitest';
import {
  createVirtualMachineBCH,
  generateSigningSerializationBCH,
  hash256,
  hexToBin,
  secp256k1,
  type CompilationContextBCH,
  type Output,
} from '@bitauth/libauth';
import {
  connectorP2pkhLock,
  connectorPublicKey,
  connectorSigningSerialization,
  signConnectorInput,
  signConnectorP2pkh,
} from '../ConnectSigningCore';
import { createP2pkhUTXOSpendable } from '../../cashconnect/cashconnectSpendable';

// Public deterministic test scalar; never a wallet or network credential.
const key = hexToBin('00'.repeat(31) + '01');
const otherKey = hexToBin('00'.repeat(31) + '02');
const publicKey = secp256k1.derivePublicKeyCompressed(key);
if (typeof publicKey === 'string') throw new Error(publicKey);
const locking = connectorP2pkhLock(publicKey);

function context(withTokens = false): CompilationContextBCH {
  const source: Output = {
    valueSatoshis: 100_000n,
    lockingBytecode: locking,
    ...(withTokens
      ? {
          token: {
            category: Uint8Array.from({ length: 32 }, (_, index) => index),
            amount: 253n,
            nft: {
              capability: 'mutable' as const,
              commitment: new Uint8Array([1, 2, 3]),
            },
          },
        }
      : {}),
  };
  return {
    inputIndex: 0,
    sourceOutputs: [
      source,
      {
        valueSatoshis: 5000n,
        lockingBytecode: connectorP2pkhLock(connectorPublicKey(otherKey)),
      },
    ],
    transaction: {
      version: 2,
      locktime: 123,
      inputs: [0, 1].map((index) => ({
        outpointTransactionHash: Uint8Array.from(
          { length: 32 },
          (_, byte) => byte + index
        ),
        outpointIndex: index,
        sequenceNumber: 0xfffffffe - index,
        unlockingBytecode: new Uint8Array(),
      })),
      outputs: [{ ...source, valueSatoshis: 104_000n }],
    },
  };
}

describe('shared Rust connector signing', () => {
  it('derives the same compressed public key as the reference library', () => {
    expect(connectorPublicKey(key)).toEqual(publicKey);
  });

  for (const mode of [0x41, 0x61]) {
    for (const withTokens of [false, true]) {
      it(`matches BCH serialization and Schnorr bytes: mode ${mode}, tokens ${withTokens}`, () => {
        const current = context(withTokens);
        const expected = generateSigningSerializationBCH(current, {
          coveredBytecode: locking,
          signingSerializationType: new Uint8Array([mode]),
        });
        expect(connectorSigningSerialization(current, locking, mode)).toEqual(
          expected
        );
        const signature = secp256k1.signMessageHashSchnorr(
          key,
          hash256(expected)
        );
        if (typeof signature === 'string') throw new Error(signature);
        expect(signConnectorInput(current, key, locking, mode)).toEqual(
          Uint8Array.from([...signature, mode])
        );
        current.transaction.inputs[0].unlockingBytecode = signConnectorP2pkh(
          current,
          key,
          mode
        );
        current.transaction.inputs[1].unlockingBytecode = signConnectorP2pkh(
          { ...current, inputIndex: 1 },
          otherKey,
          mode
        );
        expect(
          createVirtualMachineBCH().verify({
            transaction: current.transaction,
            sourceOutputs: current.sourceOutputs,
          })
        ).toBe(true);
      });
    }
  }

  it('routes the CashConnect compiler adapter through the same complete-context signer', () => {
    const current = context(true);
    const coin = createP2pkhUTXOSpendable({ privateKey: key, publicKey });
    const directive = coin.toUnlockingDirective();
    expect(directive.data).not.toHaveProperty('keys');
    const generated = directive.compiler.generateBytecode({
      scriptId: directive.script,
      data: { ...directive.data, compilationContext: current },
    });
    expect(generated.success).toBe(true);
    if (!generated.success) throw new Error('CashConnect signing failed');
    expect(generated.bytecode).toEqual(signConnectorP2pkh(current, key));
    current.transaction.inputs[0].unlockingBytecode = generated.bytecode;
    current.transaction.inputs[1].unlockingBytecode = signConnectorP2pkh(
      { ...current, inputIndex: 1 },
      otherKey
    );
    expect(
      createVirtualMachineBCH().verify({
        transaction: current.transaction,
        sourceOutputs: current.sourceOutputs,
      })
    ).toBe(true);
  });

  it('commits to the other input value and token data under SIGHASH_UTXOS', () => {
    const current = context(true);
    const before = signConnectorInput(current, key, locking, 0x61);
    current.sourceOutputs[1].valueSatoshis += 1n;
    expect(signConnectorInput(current, key, locking, 0x61)).not.toEqual(before);
    current.sourceOutputs[1].token = {
      category: new Uint8Array(32),
      amount: 1n,
    };
    const afterValue = signConnectorInput(current, key, locking, 0x61);
    current.sourceOutputs[1].token.amount = 2n;
    expect(signConnectorInput(current, key, locking, 0x61)).not.toEqual(
      afterValue
    );
  });

  it('rejects missing sources, duplicate inputs, unsupported modes and the wrong key', () => {
    const missing = context();
    missing.sourceOutputs.pop();
    expect(() => signConnectorInput(missing, key, locking, 0x61)).toThrow();
    const duplicate = context();
    duplicate.transaction.inputs[1] = duplicate.transaction.inputs[0];
    expect(() => signConnectorInput(duplicate, key, locking, 0x61)).toThrow();
    expect(() => signConnectorInput(context(), key, locking, 0x81)).toThrow();
    const wrongKey = key.slice();
    wrongKey[31] = 2;
    expect(() =>
      signConnectorInput(context(), wrongKey, locking, 0x61)
    ).toThrow();
    expect(() =>
      signConnectorInput(context(), new Uint8Array(32), locking, 0x61)
    ).toThrow();
  });

  it('rejects negative, excessive and imprecisely represented amounts', () => {
    for (const value of [-1n, 2_100_000_000_000_001n]) {
      const current = context();
      current.sourceOutputs[0].valueSatoshis = value;
      expect(() => signConnectorInput(current, key, locking, 0x61)).toThrow();
    }
    const current = context();
    current.sourceOutputs[0].valueSatoshis = 100_000 as unknown as bigint;
    expect(() => signConnectorInput(current, key, locking, 0x61)).toThrow();
    const excessiveToken = context(true);
    excessiveToken.sourceOutputs[0].token!.amount = 1n << 63n;
    expect(() =>
      signConnectorInput(excessiveToken, key, locking, 0x61)
    ).toThrow();
  });
});
