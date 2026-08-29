// Regenerates test-vectors/rpa.json. Skipped unless asked for, because the
// vectors exist to catch drift -- regenerating them on a red test would erase
// the only thing keeping the wallet and the CLI in step. Run it when the
// protocol itself changes:
//   GEN_RPA_VECTORS=1 npx vitest run src/services/__tests__/tmpGenVectors.test.ts
import { describe, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { binToHex, hexToBin, secp256k1 } from '@bitauth/libauth';
import { Network } from '../../state/slices/networkSlice';
import {
  computeSharedSecret,
  derivePaymentAddress,
  deriveRpaKeys,
  deriveSpendingKey,
  encodePaycode,
  getRpaKeyPaths,
  rpaGrindString,
  RPA_PREFIX_BITS,
} from '../RpaService';

// The BIP39 specification's own test vector. Publicly documented, so nothing
// here is a secret, and any implementation can reproduce these values.
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// Sender key and outpoint from Selene bch-rpa's test/fixtures.ts, so the
// shared-secret vectors below can be checked against a third implementation.
const SENDER_PRIVKEY =
  '0000000000000000000000000000000000000000000000000000000000000025';
const OUTPOINT_TXID =
  'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

describe.skipIf(process.env.GEN_RPA_VECTORS !== '1')('generate', () => {
  it('writes test-vectors/rpa.json', async () => {
    const networks: Array<[string, Network]> = [
      ['mainnet', Network.MAINNET],
      ['chipnet', Network.CHIPNET],
    ];

    const wallets = [];
    for (const [name, network] of networks) {
      const keys = await deriveRpaKeys(MNEMONIC, '', network);
      const paths = getRpaKeyPaths(network);
      const secret = computeSharedSecret(
        hexToBin(SENDER_PRIVKEY),
        keys.scanPubkey,
        OUTPOINT_TXID,
        0
      );
      const paymentAddress = derivePaymentAddress(
        keys.spendPubkey,
        secret,
        network,
        0
      );
      const spendingKey = await deriveSpendingKey(keys.spendPrivkey, secret, 0);
      const spendingPubkey = secp256k1.derivePublicKeyCompressed(spendingKey);
      if (typeof spendingPubkey === 'string') throw new Error(spendingPubkey);

      wallets.push({
        network: name,
        scanPath: paths.scan,
        spendPath: paths.spend,
        scanPubkey: binToHex(keys.scanPubkey),
        spendPubkey: binToHex(keys.spendPubkey),
        grindString16: rpaGrindString(keys.scanPubkey, RPA_PREFIX_BITS),
        cashcode: encodePaycode(
          keys.scanPubkey,
          keys.spendPubkey,
          network,
          RPA_PREFIX_BITS
        ),
        legacyPaycode: encodePaycode(
          keys.scanPubkey,
          keys.spendPubkey,
          network,
          RPA_PREFIX_BITS,
          'legacy-paycode'
        ),
        sharedSecret: binToHex(secret),
        paymentAddress,
        spendingPubkey: binToHex(Uint8Array.from(spendingPubkey)),
      });
    }

    // Externally anchored: Selene bch-rpa publishes these in its interop suite.
    const small = (n: number) => {
      const k = new Uint8Array(32);
      k[31] = n;
      return k;
    };
    const pub = (k: Uint8Array) => {
      const p = secp256k1.derivePublicKeyCompressed(k);
      if (typeof p === 'string') throw new Error(p);
      return binToHex(Uint8Array.from(p));
    };

    const doc = {
      $comment:
        'Shared RPA vectors. Consumed by BOTH implementations: the TypeScript ' +
        'wallet (src/services/__tests__/RpaSharedVectors.test.ts) and the Rust ' +
        'CLI (crates/optn-cli/tests/shared_vectors.rs). They exist so the two ' +
        'cannot drift silently. Regenerate only when the protocol itself ' +
        'changes, never to make a failing test pass.',
      mnemonic: MNEMONIC,
      passphrase: '',
      sender: { privkey: SENDER_PRIVKEY, outpointTxid: OUTPOINT_TXID, outpointIndex: 0 },
      reference: {
        $comment:
          'From Selene bch-rpa test/fixtures.ts and test/interop.test.ts, which ' +
          'in turn derive from the Electron Cash reference. Anchors these ' +
          'vectors to a third implementation rather than only to ourselves.',
        scanPrivkey7: pub(small(7)),
        spendPrivkey13: pub(small(13)),
        senderPrivkey37: pub(small(37)),
        sharedSecret_7_x_13G: binToHex(
          computeSharedSecret(small(7), hexToBin(pub(small(13))), OUTPOINT_TXID, 0)
        ),
        sharedSecret_37_x_7G_257bit: binToHex(
          computeSharedSecret(small(37), hexToBin(pub(small(7))), OUTPOINT_TXID, 0)
        ),
      },
      wallets,
    };

    writeFileSync('test-vectors/rpa.json', JSON.stringify(doc, null, 2) + '\n');
    console.log(JSON.stringify(doc, null, 2));
  });
});
