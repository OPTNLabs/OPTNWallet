// Multisig watch-only policy: derivation and Paytaca .pmwif interop.
//
// Real xPubs, derived with libauth, so the address claims are checkable rather
// than shape-only.

import { describe, expect, it } from 'vitest';
import {
  binToHex,
  deriveHdPath,
  deriveHdPublicNode,
  encodeHdPublicKey,
  deriveHdPrivateNodeFromSeed,
} from '@bitauth/libauth';

import {
  cosignersMissingFingerprint,
  deriveMultisigAddress,
  describePolicy,
  multisigWalletUuid,
  parsePmwif,
  pmwifFilename,
  serializePmwif,
  validateMultisigPolicy,
  type MultisigPolicy,
} from '../multisigWallet';
import { parseMultisigRedeemScript } from '../psbtMultisig';

/** An account xPub at m/44'/145'/0' from a deterministic seed. */
function accountXpub(seedByte: number): string {
  const master = deriveHdPrivateNodeFromSeed(new Uint8Array(32).fill(seedByte), {
    assumeValidity: true,
  });
  const account = deriveHdPath(master, "m/44'/145'/0'");
  if (typeof account === 'string') throw new Error(account);
  const encoded = encodeHdPublicKey({
    network: 'mainnet',
    node: deriveHdPublicNode(account),
  });
  if (typeof encoded === 'string') throw new Error(encoded);
  return encoded.hdPublicKey;
}

const XPUB_A = accountXpub(0x01);
const XPUB_B = accountXpub(0x02);
const XPUB_C = accountXpub(0x03);

const POLICY: MultisigPolicy = {
  name: 'Treasury',
  m: 2,
  signers: [
    { name: 'Alice', xpub: XPUB_A, masterFingerprintHex: 'aabbccdd' },
    { name: 'Bob', xpub: XPUB_B, masterFingerprintHex: '11223344' },
    { name: 'Carol', xpub: XPUB_C },
  ],
};

describe('multisig policy validation', () => {
  it('accepts a 2-of-3', () => {
    expect(() => validateMultisigPolicy(POLICY)).not.toThrow();
    expect(describePolicy(POLICY)).toBe('2-of-3');
  });

  it('rejects a threshold above the cosigner count', () => {
    expect(() =>
      validateMultisigPolicy({ ...POLICY, m: 4 })
    ).toThrow(/between 1 and 3/);
  });

  it('rejects a duplicated cosigner key', () => {
    // 2-of-3 where two "cosigners" are the same key is really 2-of-2 with one
    // device able to sign twice — the threshold would not mean what it says.
    expect(() =>
      validateMultisigPolicy({
        ...POLICY,
        signers: [POLICY.signers[0], POLICY.signers[1], POLICY.signers[0]],
      })
    ).toThrow(/repeats an xPub/);
  });

  it('rejects a single-cosigner wallet', () => {
    expect(() =>
      validateMultisigPolicy({ ...POLICY, m: 1, signers: [POLICY.signers[0]] })
    ).toThrow(/at least two cosigners/);
  });

  it('reports which cosigners still need a fingerprint', () => {
    const missing = cosignersMissingFingerprint(POLICY);
    expect(missing.map((signer) => signer.name)).toEqual(['Carol']);
  });
});

describe('multisig address derivation', () => {
  it('locks to P2SH20 of an OP_2 ... OP_3 CHECKMULTISIG redeem script', () => {
    const address = deriveMultisigAddress(POLICY, 0, 0);
    const parsed = parseMultisigRedeemScript(address.redeemScript);
    expect(parsed).not.toBeNull();
    expect(parsed!.requiredSignatures).toBe(2);
    expect(parsed!.totalSignatures).toBe(3);
    // OP_HASH160 <20 bytes> OP_EQUAL
    expect(address.lockingBytecode).toHaveLength(23);
    expect(address.lockingBytecode[0]).toBe(0xa9);
    expect(address.lockingBytecode[22]).toBe(0x87);
  });

  it('sorts keys BIP-67 within each address', () => {
    const { sortedPublicKeys } = deriveMultisigAddress(POLICY, 0, 0);
    const asHex = sortedPublicKeys.map(binToHex);
    expect([...asHex].sort()).toEqual(asHex);
  });

  it('gives receive and change branches different addresses', () => {
    const receive = deriveMultisigAddress(POLICY, 0, 0);
    const change = deriveMultisigAddress(POLICY, 1, 0);
    expect(binToHex(receive.lockingBytecode)).not.toBe(
      binToHex(change.lockingBytecode)
    );
  });

  it('does not depend on the order cosigners were entered', () => {
    // The BIP-67 sort is what makes this true, and it is the property that
    // lets cosigners assemble the same wallet without agreeing on an order.
    const reordered: MultisigPolicy = {
      ...POLICY,
      signers: [POLICY.signers[2], POLICY.signers[0], POLICY.signers[1]],
    };
    expect(multisigWalletUuid(reordered)).toBe(multisigWalletUuid(POLICY));
  });

  it('sorts per address, not once over the xPubs', () => {
    // Paytaca sorts the derived keys at each path. Two cosigners can trade
    // places between indexes, so a wallet that sorted xPubs once would
    // eventually derive an address nobody else agrees with. Scan until the
    // relative order actually differs from index 0 — if it never does across
    // this range the test is inconclusive rather than passing quietly.
    const orderAt = (index: number) =>
      deriveMultisigAddress(POLICY, 0, index).sortedPublicKeys.map(binToHex);
    const first = orderAt(0);
    const firstOwners = first.map((key) => key.slice(0, 8));
    let sawDifferentOrder = false;
    for (let index = 1; index < 40; index += 1) {
      const owners = orderAt(index).map((key) => key.slice(0, 8));
      if (owners.join() !== firstOwners.join()) {
        sawDifferentOrder = true;
        break;
      }
    }
    // Each address is still internally sorted regardless.
    for (let index = 0; index < 5; index += 1) {
      const keys = orderAt(index);
      expect([...keys].sort()).toEqual(keys);
    }
    expect(sawDifferentOrder).toBe(true);
  });
});

describe('Paytaca .pmwif interop', () => {
  it('names the file the way Paytaca does', () => {
    expect(pmwifFilename(POLICY)).toBe('Treasury.pmwif');
    expect(pmwifFilename({ ...POLICY, name: '  ' })).toBe(
      '2-of-3-multisig-wallet.pmwif'
    );
  });

  it('writes Paytaca\'s wallet shape', () => {
    const parsed = JSON.parse(serializePmwif(POLICY)) as Record<string, unknown>;
    expect(parsed.name).toBe('Treasury');
    expect(parsed.m).toBe(2);
    expect(parsed.signers).toEqual([
      { name: 'Alice', xpub: XPUB_A },
      { name: 'Bob', xpub: XPUB_B },
      { name: 'Carol', xpub: XPUB_C },
    ]);
  });

  it('round-trips a wallet without losing fingerprints', () => {
    const restored = parsePmwif(serializePmwif(POLICY));
    expect(restored.m).toBe(2);
    expect(restored.signers.map((signer) => signer.masterFingerprintHex)).toEqual(
      ['aabbccdd', '11223344', undefined]
    );
    expect(multisigWalletUuid(restored)).toBe(multisigWalletUuid(POLICY));
  });

  it('imports a file straight from Paytaca, which has no fingerprints', () => {
    const paytaca = JSON.stringify({
      name: 'Shared',
      m: 2,
      signers: [
        { name: 'One', xpub: XPUB_A },
        { name: 'Two', xpub: XPUB_B },
        { name: 'Three', xpub: XPUB_C },
      ],
    });
    const policy = parsePmwif(paytaca);
    expect(policy.name).toBe('Shared');
    expect(cosignersMissingFingerprint(policy)).toHaveLength(3);
    // Still derives the same addresses — fingerprints matter for signing, not
    // for watching.
    expect(multisigWalletUuid(policy)).toBe(multisigWalletUuid(POLICY));
  });

  it('survives a reordered signer list without misassigning fingerprints', () => {
    const written = JSON.parse(serializePmwif(POLICY)) as Record<string, unknown>;
    written.signers = (written.signers as unknown[]).slice().reverse();
    const policy = parsePmwif(JSON.stringify(written));
    const byName = new Map(
      policy.signers.map((signer) => [signer.name, signer.masterFingerprintHex])
    );
    expect(byName.get('Alice')).toBe('aabbccdd');
    expect(byName.get('Bob')).toBe('11223344');
    expect(byName.get('Carol')).toBeUndefined();
  });

  it('matches OPTN fingerprint metadata after xpub whitespace is normalized', () => {
    const written = JSON.parse(serializePmwif(POLICY)) as {
      optn: { cosigners: Array<{ xpub: string }> };
    };
    written.optn.cosigners[0].xpub = ` ${XPUB_A} `;

    const policy = parsePmwif(JSON.stringify(written));
    expect(policy.signers[0].masterFingerprintHex).toBe('aabbccdd');
  });

  it('rejects malformed files with a usable message', () => {
    expect(() => parsePmwif('not json')).toThrow(/not valid JSON/);
    expect(() => parsePmwif('{"m":2}')).toThrow(/no cosigners/);
    expect(() =>
      parsePmwif(JSON.stringify({ m: 0, signers: [{ xpub: XPUB_A }] }))
    ).toThrow(/valid "m"/);
    expect(() =>
      parsePmwif(
        JSON.stringify({ m: 2, signers: [{ xpub: XPUB_A }, { xpub: 'nope' }] })
      )
    ).toThrow(/cannot be read/);
  });
});
