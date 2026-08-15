import { describe, expect, it } from 'vitest';
import { Network } from '../../state/slices/networkSlice';
import { classifyScannedQrPayload, isWalletConnectUri } from '../qrScan';

const MAINNET_ADDRESS =
  'bitcoincash:qrx6fypj230kpgvghmyje089sphvl4jnfqq4aduatz';

describe('classifyScannedQrPayload', () => {
  it('classifies CashConnect invites before other payloads', () => {
    const uri =
      'bch-cc-v1:ad6f1bc041b666007c6b6ea0a5151ad09ecef2139123a40e5cfbbebd93e425e0?relay=wss://nostr.infra.cash';
    expect(classifyScannedQrPayload(uri, Network.MAINNET)).toEqual({
      kind: 'cashconnect',
      scannedValue: uri,
      uri,
    });
  });

  it('classifies WalletConnect URIs', () => {
    const uri = 'wc:abc123@2?relay-protocol=irn&symKey=deadbeef';
    expect(isWalletConnectUri(uri)).toBe(true);
    expect(classifyScannedQrPayload(uri, Network.MAINNET)).toEqual({
      kind: 'walletconnect',
      scannedValue: uri,
      uri,
    });
  });

  it('still classifies payment addresses', () => {
    const parsed = classifyScannedQrPayload(MAINNET_ADDRESS, Network.MAINNET);
    expect(parsed.kind).toBe('recipient');
    if (parsed.kind === 'recipient') {
      expect(parsed.normalizedAddress).toBe(MAINNET_ADDRESS);
    }
  });

  it('returns unknown for empty or unrelated text', () => {
    expect(classifyScannedQrPayload('', Network.MAINNET).kind).toBe('unknown');
    expect(classifyScannedQrPayload('hello', Network.MAINNET).kind).toBe(
      'unknown'
    );
  });

  it('recognizes a merchant proposal QR stream frame', () => {
    const initialQrPayload = 'qrstream/1/AQID';

    expect(classifyScannedQrPayload(initialQrPayload, Network.MAINNET)).toEqual(
      {
        kind: 'merchant-proposal-stream',
        initialQrPayload,
      }
    );
  });
});
