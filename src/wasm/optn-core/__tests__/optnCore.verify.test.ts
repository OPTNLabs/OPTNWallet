// Does the Rust core, reached through wasm from JavaScript, produce the same
// values as the shared vectors?
//
// This is the check that makes the core usable from the wallet. The vectors are
// already read by the TypeScript implementation and by the Rust one; adding the
// wasm binding as a third reader means all three must agree, so swapping
// RpaService.ts onto the core cannot silently change behaviour.
//
// Same role as tinySecp256k1SyncLoader.verify.test.ts: prove the loading
// mechanism gives the same answers as the thing it replaces.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  decodeCashcode,
  encodeCashcode,
  ensureOptnCore,
  grindString,
  looksLikeRpa,
  paymentAddress,
  sendBlockReason,
  sharedSecret,
} from '..';

type Wallet = {
  network: string;
  scanPubkey: string;
  spendPubkey: string;
  grindString16: string;
  cashcode: string;
  legacyPaycode: string;
  sharedSecret: string;
  paymentAddress: string;
};

const vectors = JSON.parse(readFileSync('test-vectors/rpa.json', 'utf8')) as {
  sender: { privkey: string; outpointTxid: string; outpointIndex: number };
  reference: Record<string, string>;
  wallets: Wallet[];
};

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function smallKey(n: number): Uint8Array {
  const k = new Uint8Array(32);
  k[31] = n;
  return k;
}

describe('optn-core through wasm', () => {
  it('instantiates synchronously, with no top-level await', () => {
    // If this needed an await, the mobile build would be back to the failure
    // tinySecp256k1SyncLoader.ts exists to avoid.
    expect(() => ensureOptnCore()).not.toThrow();
    expect(() => ensureOptnCore()).not.toThrow(); // idempotent
  });

  it('matches the external bch-rpa reference secrets', () => {
    ensureOptnCore();
    const r = vectors.reference;
    const txid = vectors.sender.outpointTxid;

    expect(
      bytesToHex(sharedSecret(smallKey(7), hexToBytes(r.spendPrivkey13), txid, 0))
    ).toBe(r.sharedSecret_7_x_13G);

    // The 257-bit grand-sum case, where a fixed-width addition would silently
    // produce a different digest.
    expect(
      bytesToHex(sharedSecret(smallKey(37), hexToBytes(r.scanPrivkey7), txid, 0))
    ).toBe(r.sharedSecret_37_x_7G_257bit);
  });

  it('rejects a wrong-length key at the boundary instead of computing on it', () => {
    ensureOptnCore();
    expect(() => sharedSecret(new Uint8Array(31), hexToBytes(vectors.wallets[0].scanPubkey), 'ab'.repeat(32), 0)).toThrow(
      /32 bytes/
    );
    expect(() => grindString(new Uint8Array(32), 16)).toThrow(/33 bytes/);
  });

  for (const w of vectors.wallets) {
    it(`reproduces every ${w.network} vector`, () => {
      ensureOptnCore();
      const scan = hexToBytes(w.scanPubkey);
      const spend = hexToBytes(w.spendPubkey);

      expect(grindString(scan, 16)).toBe(w.grindString16);
      expect(encodeCashcode(scan, spend, w.network, 16)).toBe(w.cashcode);

      const decoded = JSON.parse(decodeCashcode(w.cashcode));
      expect(decoded.scanPubkey).toBe(w.scanPubkey);
      expect(decoded.spendPubkey).toBe(w.spendPubkey);
      expect(decoded.legacy).toBe(false);

      // Legacy paycodes stay acceptable, and are flagged as legacy.
      expect(looksLikeRpa(w.legacyPaycode)).toBe(true);
      expect(JSON.parse(decodeCashcode(w.legacyPaycode)).legacy).toBe(true);

      // Neither form is offline-only nor prefix-0, so neither is blocked.
      expect(sendBlockReason(w.cashcode)).toBeUndefined();

      const secret = sharedSecret(
        hexToBytes(vectors.sender.privkey),
        scan,
        vectors.sender.outpointTxid,
        vectors.sender.outpointIndex
      );
      expect(bytesToHex(secret)).toBe(w.sharedSecret);
      expect(paymentAddress(spend, secret, w.network, 0)).toBe(w.paymentAddress);
    });
  }
});
