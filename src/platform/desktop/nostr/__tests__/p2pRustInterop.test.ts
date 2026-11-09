// Do the desktop's TypeScript peers accept what a Rust peer sends?
//
// test-vectors/p2p-fusion-rust.json is written by the Rust P2P CashFusion
// implementation (`cargo run -p optn-fusion --example p2p_fusion_vectors`). A
// mixed round of desktop wallets and CLI or docker peers works only if every
// one of these passes here, through the same functions a live round uses. The
// other direction, Rust reproducing the TypeScript, is test-vectors/p2p-fusion.json.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hexToBin } from '@bitauth/libauth';

import vectors from '../../../../../test-vectors/p2p-fusion-rust.json';
import {
  parseRoundMessage,
  verifyAuthorizedOutputBatch,
} from '../fusionSession';
import {
  decodeAuthorizedOutput,
  onionPeel,
  onionUnpadRaw,
} from '../onionCrypto';
import { assembleFusionTx } from '../fusionRound';
import { verifyFinalFusionTx } from '../fusionSign';
import {
  inputCredentialMessageHashHex,
  verifyBchSchnorrHex,
} from '../fusionBlindSchnorr';
import { pedersenBalanceHolds } from '../fusionPedersen';

describe('a Rust P2P CashFusion peer, as the TypeScript peers see it', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(vectors.nowUnix * 1000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends only messages the strict parser accepts', () => {
    expect(vectors.messages.length).toBeGreaterThanOrEqual(16);
    for (const json of vectors.messages) {
      expect(parseRoundMessage(json), json.slice(0, 80)).not.toBeNull();
    }
    const kinds = vectors.messages.map(
      (json) => (JSON.parse(json) as { type: string }).type
    );
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it('wraps an onion every TypeScript peeler can peel', async () => {
    let blob = Uint8Array.from(Buffer.from(vectors.onion.blob, 'base64'));
    for (const secret of vectors.onion.peelerSecrets) {
      blob = await onionPeel(blob, hexToBin(secret));
    }
    const payload = onionUnpadRaw(blob);
    expect(payload).toBe(vectors.onion.payload);
    expect(decodeAuthorizedOutput(payload)).toEqual(
      vectors.credentials.outputs[0]
    );
  });

  it('issues credentials a TypeScript coordinator verifies', () => {
    const { issuerPubkey } = vectors.credentials;
    vectors.credentials.inputs.forEach((input, index) => {
      expect(
        verifyBchSchnorrHex(
          issuerPubkey,
          vectors.credentials.inputCredentials[index],
          inputCredentialMessageHashHex(
            input,
            vectors.credentials.inputSaltCommitments[index]
          )
        )
      ).toBe(true);
    });
    const batch = verifyAuthorizedOutputBatch(
      vectors.credentials.outputs,
      vectors.credentials.outputs.length,
      issuerPubkey,
      { session: vectors.session, network: 'chipnet', tier: 100_000 }
    );
    expect(batch.ok).toBe(true);
    expect(
      pedersenBalanceHolds(
        vectors.credentials.amountCommitments,
        vectors.credentials.excessFee,
        vectors.credentials.pedersenTotalNonce
      )
    ).toBe(true);
  });

  it('assembles the same canonical transaction', () => {
    const tx = assembleFusionTx([vectors.finalTx.contribution]);
    expect(tx).toEqual(vectors.finalTx.assembled);
  });

  it('signs a final transaction that passes the BCH VM check', () => {
    const verified = verifyFinalFusionTx(
      vectors.finalTx.assembled,
      vectors.finalTx.txHex,
      vectors.finalTx.txid
    );
    expect(verified.txid).toBe(vectors.finalTx.txid);
  });
});
