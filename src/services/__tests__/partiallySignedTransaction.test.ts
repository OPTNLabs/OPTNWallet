import { describe, expect, it } from 'vitest';
import {
  createSigningResponse,
  deserializePartiallySignedTransaction,
  serializePartiallySignedTransaction,
  type PartiallySignedTransaction,
} from '../partiallySignedTransaction';

const request: PartiallySignedTransaction = {
  version: 1,
  network: 'chipnet',
  unsignedTransaction: {
    version: 2,
    inputs: [{ outpointIndex: 0, unlockingBytecode: new Uint8Array() }],
    outputs: [{ valueSatoshis: 9000n, lockingBytecode: new Uint8Array([0x51]) }],
  },
  sourceOutputs: [{ valueSatoshis: 10_000n, lockingBytecode: new Uint8Array([0x51]) }],
  inputs: [
    {
      index: 0,
      signerRole: 'wallet',
      status: 'unsigned',
      derivationPath: 'm/44\'/145\'/0\'/0/0',
      partialSignatures: [],
    },
  ],
  metadata: {
    requestId: 'request-1',
    purpose: 'QR signing demo',
    createdAt: 1,
    transactionFingerprint: '12345678',
  },
};

describe('partiallySignedTransaction', () => {
  it('round-trips bigint and byte fields through the QR payload serializer', () => {
    const decoded = deserializePartiallySignedTransaction(
      serializePartiallySignedTransaction(request)
    );
    expect(decoded).toEqual(request);
  });

  it('creates a response bound to the request fingerprint', () => {
    expect(
      createSigningResponse({
        request,
        signerLabel: 'Demo signer',
        approved: true,
        inputIndex: 0,
        publicKey: '02demo',
        signature: 'signature',
      })
    ).toMatchObject({
      requestId: 'request-1',
      transactionFingerprint: '12345678',
      approved: true,
      signatures: [{ inputIndex: 0 }],
    });
  });
});
