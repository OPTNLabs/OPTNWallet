import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import MerchantPayApp from '../MerchantPayApp';
import { Network } from '../../../../state/slices/networkSlice';
import { buildMerchantPaymentRequest } from '../merchantPayRequest';

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/apps/merchant-pay' }),
  useNavigate: () => vi.fn(),
}));

vi.mock('react-redux', () => ({
  useSelector: (selector: (state: unknown) => unknown) =>
    selector({ wallet_id: { currentWalletId: 1 } }),
}));

vi.mock('../../../../state/selectors/networkSelectors', () => ({
  selectCurrentNetwork: () => 'mainnet',
}));

vi.mock('../../../../components/ui/WalletScreen', () => ({
  default: ({
    children,
    scrollable,
    maxWidthClassName,
  }: {
    children: ReactNode;
    scrollable?: boolean;
    maxWidthClassName?: string;
  }) => (
    <div
      data-scrollable={String(scrollable)}
      data-max-width={maxWidthClassName}
    >
      {children}
    </div>
  ),
}));

vi.mock('../../../../services/cauldron', () => ({
  CAULDRON_NATIVE_BCH: 'bch',
  CauldronApiClient: class {},
  fetchNormalizedCauldronPools: vi.fn(),
  planAggregatedTradeForTargetDemand: vi.fn(),
}));

vi.mock('../../../../services/cauldron/amount', () => ({
  parseDecimalToAtomic: () => 0n,
}));

vi.mock('../../shared/useSmoothResetTransition', () => ({
  useSmoothResetTransition: () => ({
    contentClassName: '',
    runSmoothReset: async (task: () => void) => task(),
  }),
}));

describe('MerchantPayApp', () => {
  it('renders the merchant screen without enabling wallet scrolling', () => {
    const html = renderToStaticMarkup(
      <MerchantPayApp
        sdk={{ wallet: { listAddresses: vi.fn() } } as never}
        manifest={{ id: 'optn.builtin.merchant-pay' } as never}
        app={{ name: 'Merchant Pay' } as never}
      />
    );

    expect(html).toContain('data-scrollable="false"');
    expect(html).toContain('Choose stablecoin.');
    expect(html).toContain('Continue');
  });

  it('builds a merchant request from the current draft quote without refreshing pools', async () => {
    const request = await buildMerchantPaymentRequest({
      sdk: {
        utxos: {
          listForAddress: vi.fn(async () => [
            {
              address: 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a',
              tokenAddress: 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a',
              tx_hash: 'aa'.repeat(32),
              tx_pos: 1,
              value: 12_345,
              amount: 12_345,
              height: 12,
            },
          ]),
        },
        wallet: {
          listAddresses: vi.fn(async () => [
            {
              address: 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a',
            },
          ]),
        },
      } as never,
      currentNetwork: Network.MAINNET,
      selectedStablecoin: {
        tokenId:
          'b38a33f750f84c5c169a6f23cb873e6e79605021585d4f3408789689ed87f366',
        symbol: 'MUSD',
        name: 'Moria USD',
        decimals: 2,
      },
      draftQuote: {
        createdAt: 1_000_000,
        expiresAt: 1_120_000,
        merchantReceivesAtomic: 1_000n,
        merchantReceivesDisplay: '10.00 MUSD',
        customerPaysSats: 8_400_000n,
        customerPaysDisplay: '0.084 BCH',
        routePoolCount: 2,
        quoteProtectionBps: 100n,
      },
    });

    expect(request.merchantReceivesDisplay).toBe('10.00 MUSD');
    expect(request.customerPaysDisplay).toBe('0.084 BCH');
    expect(request.merchantAddress).toBe(
      'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'
    );
    expect(request.paymentUri).toContain(
      'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'
    );
    expect(request.paymentUri).toContain('amount=0.084');
    expect(request.paymentUri).toContain('label=Merchant+Pay');
    expect(request.paymentUri).toContain('message=Merchant+receives+10.00+MUSD');
    expect(request.detailsText).toContain('BCH payment request');
    expect(request.detailsText).toContain('Quote protection: 1.00%');
    expect(request.merchantAddressBaselineOutpoints).toEqual([
      `${'aa'.repeat(32)}:1`,
    ]);
  });
});
