// The TypeScript half of the shared RPA vectors.
//
// `test-vectors/rpa.json` is read by BOTH implementations — this file and
// `crates/optn-cli/tests/shared_vectors.rs`. The wallet and the CLI are
// separate codebases with no shared code, so nothing else stops them drifting:
// a change to one is not a change to the other, and the difference would show
// up as payments that one side can see and the other cannot.
//
// The `reference` block is anchored outside this repository, to Selene's
// bch-rpa interop fixtures, so these are not merely values we agree with
// ourselves about.
//
// If a vector fails, the protocol changed or an implementation broke. Fix the
// code. Regenerating the file to make a test pass throws away the only thing
// keeping the two sides honest.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { binToHex, hexToBin, secp256k1 } from '@bitauth/libauth';
import { Network } from '../../state/slices/networkSlice';
import {
  computeSharedSecret,
  decodePaycode,
  derivePaymentAddress,
  deriveRpaKeys,
  deriveSpendingKey,
  encodePaycode,
  getRpaKeyPaths,
  rpaGrindString,
  RPA_PREFIX_BITS,
} from '../RpaService';

type Wallet = {
  network: string;
  scanPath: string;
  spendPath: string;
  scanPubkey: string;
  spendPubkey: string;
  grindString16: string;
  cashcode: string;
  legacyPaycode: string;
  sharedSecret: string;
  paymentAddress: string;
  spendingPubkey: string;
};

const vectors = JSON.parse(
  readFileSync('test-vectors/rpa.json', 'utf8')
) as {
  mnemonic: string;
  passphrase: string;
  sender: { privkey: string; outpointTxid: string; outpointIndex: number };
  reference: Record<string, string>;
  wallets: Wallet[];
};

const NETWORKS: Record<string, Network> = {
  mainnet: Network.MAINNET,
  chipnet: Network.CHIPNET,
};

function smallKey(n: number): Uint8Array {
  const k = new Uint8Array(32);
  k[31] = n;
  return k;
}

function compressedPubkey(privkey: Uint8Array): string {
  const p = secp256k1.derivePublicKeyCompressed(privkey);
  if (typeof p === 'string') throw new Error(p);
  return binToHex(Uint8Array.from(p));
}

describe('shared RPA vectors', () => {
  it('matches the external bch-rpa reference values', () => {
    const r = vectors.reference;
    expect(compressedPubkey(smallKey(7))).toBe(r.scanPrivkey7);
    expect(compressedPubkey(smallKey(13))).toBe(r.spendPrivkey13);
    expect(compressedPubkey(smallKey(37))).toBe(r.senderPrivkey37);

    const txid = vectors.sender.outpointTxid;
    expect(
      binToHex(computeSharedSecret(smallKey(7), hexToBin(r.spendPrivkey13), txid, 0))
    ).toBe(r.sharedSecret_7_x_13G);

    // The case whose grand sum overflows 32 bytes, which is where a naive
    // fixed-width addition silently produces a different digest.
    expect(
      binToHex(computeSharedSecret(smallKey(37), hexToBin(r.scanPrivkey7), txid, 0))
    ).toBe(r.sharedSecret_37_x_7G_257bit);
  });

  for (const w of vectors.wallets) {
    it(`derives the ${w.network} vectors from the shared mnemonic`, async () => {
      const network = NETWORKS[w.network];
      expect(network).toBeDefined();

      const keys = await deriveRpaKeys(vectors.mnemonic, vectors.passphrase, network);
      const paths = getRpaKeyPaths(network);

      expect(paths.scan).toBe(w.scanPath);
      expect(paths.spend).toBe(w.spendPath);
      expect(binToHex(keys.scanPubkey)).toBe(w.scanPubkey);
      expect(binToHex(keys.spendPubkey)).toBe(w.spendPubkey);
      expect(rpaGrindString(keys.scanPubkey, RPA_PREFIX_BITS)).toBe(w.grindString16);

      expect(
        encodePaycode(keys.scanPubkey, keys.spendPubkey, network, RPA_PREFIX_BITS)
      ).toBe(w.cashcode);
      expect(
        encodePaycode(
          keys.scanPubkey,
          keys.spendPubkey,
          network,
          RPA_PREFIX_BITS,
          'legacy-paycode'
        )
      ).toBe(w.legacyPaycode);

      // A legacy code must still decode, and be flagged as legacy.
      const legacy = decodePaycode(w.legacyPaycode);
      expect(legacy).not.toBeNull();
      expect(legacy!.legacy).toBe(true);
      expect(binToHex(legacy!.scanPubkey)).toBe(w.scanPubkey);
      expect(decodePaycode(w.cashcode)!.legacy).toBe(false);

      const secret = computeSharedSecret(
        hexToBin(vectors.sender.privkey),
        keys.scanPubkey,
        vectors.sender.outpointTxid,
        vectors.sender.outpointIndex
      );
      expect(binToHex(secret)).toBe(w.sharedSecret);
      expect(derivePaymentAddress(keys.spendPubkey, secret, network, 0)).toBe(
        w.paymentAddress
      );

      // And the recipient controls what the sender paid.
      const spendingKey = await deriveSpendingKey(keys.spendPrivkey, secret, 0);
      expect(compressedPubkey(spendingKey)).toBe(w.spendingPubkey);
    });
  }
});
