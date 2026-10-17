// Seeds, BIP32 and addresses moved from libauth and bip39.js into
// crates/optn-core. Every wallet already stored was derived by the old code,
// so the old code is the oracle here: each case runs both and demands the
// same bytes. If these drift, an existing wallet opens to different
// addresses.
import { describe, expect, it } from 'vitest';
import * as bip39 from 'bip39';
import {
  binToHex,
  decodeHdPublicKey,
  deriveHdPath,
  deriveHdPrivateNodeFromSeed,
  deriveHdPublicNode,
  deriveHdPublicNodeChild,
  encodeCashAddress,
  encodeHdPrivateKey,
  encodeHdPublicKey,
  hash160,
  secp256k1,
} from '@bitauth/libauth';

import { Network } from '../../state/slices/networkSlice';
import {
  bip39SeedFromMnemonic,
  generateBip39Mnemonic,
  isCanonicalBip39Mnemonic,
} from '../Bip39Service';
import {
  alignHdPublicKeyNetwork,
  deriveBchKeyMaterial,
  deriveBchPublicAddress,
  deriveHdPrivateKeyAtPath,
  deriveHdPublicKeyAtPath,
  deriveMasterFingerprint,
  derivePrivateKeyAtPath,
  derivePublicKeyFromHdPublicKey,
  getBchAddressPath,
  getBchBranchPath,
  getHdKeyNetwork,
} from '../HdWalletService';

const ZERO_MNEMONIC = bip39.entropyToMnemonic('0'.repeat(32));
const PHRASES = [
  ZERO_MNEMONIC,
  bip39.entropyToMnemonic('ff'.repeat(32)),
  bip39.entropyToMnemonic('7f'.repeat(20)),
  bip39.generateMnemonic(),
  // Not canonical. bip39.js hashed it as written, so a wallet stored this
  // way must keep the seed it has always had.
  `  Abandon  ${ZERO_MNEMONIC.split(' ').slice(1).join(' ')} `,
];
// The precomposed "ä" is NFKD-decomposed by both implementations.
const PASSPHRASES = ['', 'TREZOR', 'pässword'];
const NETWORKS = [Network.MAINNET, Network.CHIPNET];

async function oracleRoot(mnemonic: string, passphrase: string) {
  const seed = Uint8Array.from(
    await bip39.mnemonicToSeed(mnemonic, passphrase)
  );
  return deriveHdPrivateNodeFromSeed(seed, { assumeValidity: true });
}

function oracleNode(
  root: Awaited<ReturnType<typeof oracleRoot>>,
  path: string
) {
  const node = deriveHdPath(root, path);
  if (typeof node === 'string') throw new Error(node);
  return node;
}

function oracleAddresses(network: Network, publicKey: Uint8Array) {
  const payload = hash160(publicKey);
  const prefix = network === Network.MAINNET ? 'bitcoincash' : 'bchtest';
  return {
    publicKeyHash: binToHex(payload),
    address: encodeCashAddress({ payload, prefix, type: 'p2pkh' }).address,
    tokenAddress: encodeCashAddress({
      payload,
      prefix,
      type: 'p2pkhWithTokens',
    }).address,
  };
}

describe('HD derivation in optn-core matches libauth and bip39.js', () => {
  it('computes the same BIP39 seed for every phrase and passphrase', async () => {
    for (const mnemonic of PHRASES) {
      for (const passphrase of PASSPHRASES) {
        const seed = bip39SeedFromMnemonic(mnemonic, passphrase);
        expect(binToHex(seed)).toBe(
          binToHex(await bip39.mnemonicToSeed(mnemonic, passphrase))
        );
      }
    }
  });

  it('derives the same extended keys, private keys and fingerprints', async () => {
    for (const mnemonic of PHRASES) {
      for (const passphrase of PASSPHRASES) {
        const root = await oracleRoot(mnemonic, passphrase);
        expect(
          binToHex(await deriveMasterFingerprint(mnemonic, passphrase))
        ).toBe(
          binToHex(hash160(deriveHdPublicNode(root).publicKey).slice(0, 4))
        );

        for (const network of NETWORKS) {
          const hdNetwork = getHdKeyNetwork(network);
          for (const path of [
            getBchBranchPath(network, 0, 0).replace(/\/0$/, ''),
            getBchBranchPath(network, 1, 1),
            getBchAddressPath(network, 0, 7, 3),
          ]) {
            const node = oracleNode(root, path);
            const xpub = encodeHdPublicKey({
              network: hdNetwork,
              node: deriveHdPublicNode(node),
            });
            const xprv = encodeHdPrivateKey({ network: hdNetwork, node });
            if (typeof xpub === 'string' || typeof xprv === 'string') {
              throw new Error('oracle could not encode');
            }
            expect(
              await deriveHdPublicKeyAtPath(mnemonic, passphrase, network, path)
            ).toBe(xpub.hdPublicKey);
            expect(
              await deriveHdPrivateKeyAtPath(
                mnemonic,
                passphrase,
                network,
                path
              )
            ).toBe(xprv.hdPrivateKey);
            expect(
              binToHex(await derivePrivateKeyAtPath(mnemonic, passphrase, path))
            ).toBe(binToHex(node.privateKey));
          }
        }
      }
    }
  });

  it('derives the same key material and addresses at wallet paths', async () => {
    for (const mnemonic of PHRASES.slice(0, 3)) {
      const root = await oracleRoot(mnemonic, 'TREZOR');
      for (const network of NETWORKS) {
        for (const [branch, index] of [
          [0, 0],
          [1, 19],
          [7, 2],
        ]) {
          const node = oracleNode(
            root,
            getBchAddressPath(network, 0, branch, index)
          );
          const publicKey = secp256k1.derivePublicKeyCompressed(
            node.privateKey
          );
          if (typeof publicKey === 'string') throw new Error(publicKey);
          const material = await deriveBchKeyMaterial(
            network,
            mnemonic,
            'TREZOR',
            0,
            branch,
            index
          );
          expect(material).not.toBeNull();
          expect(binToHex(material!.privateKey)).toBe(
            binToHex(node.privateKey)
          );
          expect(binToHex(material!.publicKey)).toBe(binToHex(publicKey));
          const expected = oracleAddresses(network, publicKey);
          expect(binToHex(material!.publicKeyHash)).toBe(
            expected.publicKeyHash
          );
          expect(material!.address).toBe(expected.address);
          expect(material!.tokenAddress).toBe(expected.tokenAddress);
        }
      }
    }
  });

  it('derives the same public children from an xpub or tpub', async () => {
    const root = await oracleRoot(ZERO_MNEMONIC, '');
    for (const network of NETWORKS) {
      const branch = getBchBranchPath(network, 0, 0);
      const encoded = encodeHdPublicKey({
        network: getHdKeyNetwork(network),
        node: deriveHdPublicNode(oracleNode(root, branch)),
      });
      if (typeof encoded === 'string') throw new Error(encoded);
      const decoded = decodeHdPublicKey(encoded.hdPublicKey);
      if (typeof decoded === 'string') throw new Error(decoded);
      for (const index of [0, 1, 1000, 0x7fffffff]) {
        const child = deriveHdPublicNodeChild(decoded.node, index);
        if (typeof child === 'string') throw new Error(child);
        expect(
          binToHex(
            derivePublicKeyFromHdPublicKey(encoded.hdPublicKey, BigInt(index))
          )
        ).toBe(binToHex(child.publicKey));
      }
      // Hardened or negative indexes cannot come from public material, and
      // must not wrap around the u32 boundary into a valid one.
      for (const index of [0x80000000n, 0x100000000n, -1n]) {
        expect(() =>
          derivePublicKeyFromHdPublicKey(encoded.hdPublicKey, index)
        ).toThrow();
      }
    }
  });

  it('re-serializes xpub and tpub exactly as libauth does', async () => {
    const root = await oracleRoot(ZERO_MNEMONIC, '');
    const node = deriveHdPublicNode(
      oracleNode(root, getBchBranchPath(Network.MAINNET, 0, 0))
    );
    const xpub = encodeHdPublicKey({ network: 'mainnet', node });
    const tpub = encodeHdPublicKey({ network: 'testnet', node });
    if (typeof xpub === 'string' || typeof tpub === 'string') {
      throw new Error('oracle could not encode');
    }
    expect(alignHdPublicKeyNetwork(Network.CHIPNET, xpub.hdPublicKey)).toBe(
      tpub.hdPublicKey
    );
    expect(alignHdPublicKeyNetwork(Network.MAINNET, tpub.hdPublicKey)).toBe(
      xpub.hdPublicKey
    );
    expect(
      alignHdPublicKeyNetwork(Network.MAINNET, ` ${xpub.hdPublicKey} `)
    ).toBe(xpub.hdPublicKey);
    const xprv = encodeHdPrivateKey({
      network: 'mainnet',
      node: oracleNode(root, "m/44'/145'/0'"),
    });
    if (typeof xprv === 'string') throw new Error(xprv);
    for (const bad of ['', '   ', 'xpub', xprv.hdPrivateKey]) {
      expect(() => alignHdPublicKeyNetwork(Network.MAINNET, bad)).toThrow(
        'Enter a valid BIP32 public key.'
      );
    }
  });

  it('encodes the same addresses for compressed and uncompressed keys', () => {
    const privateKey = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const compressed = secp256k1.derivePublicKeyCompressed(privateKey);
    const uncompressed = secp256k1.derivePublicKeyUncompressed(privateKey);
    if (typeof compressed === 'string' || typeof uncompressed === 'string') {
      throw new Error('oracle could not derive');
    }
    for (const network of NETWORKS) {
      for (const publicKey of [compressed, uncompressed]) {
        const derived = deriveBchPublicAddress(network, publicKey);
        const expected = oracleAddresses(network, publicKey);
        expect(derived && binToHex(derived.publicKeyHash)).toBe(
          expected.publicKeyHash
        );
        expect(derived?.address).toBe(expected.address);
        expect(derived?.tokenAddress).toBe(expected.tokenAddress);
      }
      expect(deriveBchPublicAddress(network, new Uint8Array(32))).toBeNull();
    }
  });
});

describe('BIP39 phrases in optn-core match bip39.js', () => {
  it('accepts exactly the phrases bip39.js validateMnemonic accepts', () => {
    const cases = [
      ...PHRASES,
      ZERO_MNEMONIC.toUpperCase(),
      ` ${ZERO_MNEMONIC}`,
      `${ZERO_MNEMONIC} `,
      ZERO_MNEMONIC.replace(' ', '  '),
      ZERO_MNEMONIC.replace('about', 'abandon'),
      ZERO_MNEMONIC.split(' ').slice(0, 9).join(' '),
      `${ZERO_MNEMONIC} abandon abandon abandon`,
      'not a mnemonic',
      '',
    ];
    for (const phrase of cases) {
      expect(isCanonicalBip39Mnemonic(phrase)).toBe(
        bip39.validateMnemonic(phrase)
      );
    }
  });

  it('generates fresh 12-word phrases that bip39.js accepts', () => {
    const first = generateBip39Mnemonic();
    const second = generateBip39Mnemonic();
    for (const phrase of [first, second]) {
      expect(phrase.split(' ')).toHaveLength(12);
      expect(bip39.validateMnemonic(phrase)).toBe(true);
    }
    expect(first).not.toBe(second);
  });
});
