import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  BcmrSnapshot,
  BcmrTokenMetadataState,
} from '../../../../types/bcmr';
import type { UTXO } from '../../../../types/types';
import RegularTxView from '../RegularTxView';

function makeMetadata(): BcmrTokenMetadataState {
  return {
    status: 'ready',
    freshness: 'fresh',
    name: 'Sample Token',
    symbol: 'SMP',
    decimals: 2,
    iconUri: 'https://example.com/icon.png',
    snapshot: {
      name: 'Sample Token',
      token: {
        category: '0123456789abcdef',
        symbol: 'SMP',
        decimals: 2,
      },
      uris: {
        icon: 'https://example.com/icon.png',
      },
      extensions: {},
    } as BcmrSnapshot,
    isRefreshing: false,
  };
}

describe('RegularTxView', () => {
  it('shows the same token identity in the selector and preview', () => {
    const tokenMetadata = {
      '0123456789abcdef': makeMetadata(),
    };

    const selectedUtxos = [
      {
        address: 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a',
        height: 100,
        tx_hash: '11'.repeat(32),
        tx_pos: 0,
        value: 1000,
        amount: 1000,
        token: {
          category: '0123456789abcdef',
          amount: 123400n,
          BcmrTokenMetadata: {
            name: 'Sample Token',
            description: 'A sample token used in tests.',
            token: {
              category: '0123456789abcdef',
              symbol: 'SMP',
              decimals: 2,
            },
            is_nft: false,
            uris: {
              icon: 'https://example.com/icon.png',
            },
            extensions: {},
          },
        },
      } as UTXO,
    ];

    const html = renderToStaticMarkup(
      <RegularTxView
        recipientAddress="bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a"
        setRecipientAddress={() => undefined}
        transferAmount={1000}
        setTransferAmount={() => undefined}
        categoriesFromSelected={['0123456789abcdef']}
        tokenAmount={0n}
        setTokenAmount={() => undefined}
        selectedTokenCategory="0123456789abcdef"
        setSelectedTokenCategory={() => undefined}
        tokenMetadata={tokenMetadata}
        selectedUtxos={selectedUtxos}
        scanBarcode={async () => undefined}
        handleAddOutput={async () => undefined}
        txOutputs={[]}
      />
    );

    expect(html).toContain('Sample Token');
    expect(html).toContain('SMP');
    expect(html).toContain('FT');
    expect(html).toContain('1234');
  });
});
