/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('react-redux', () => ({
  useSelector: (selector: (state: unknown) => unknown) =>
    selector({
      wallet_id: { currentWalletId: 7 },
      walletSpecialActivity: { byWallet: {} },
    }),
}));
vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

import { ReviewCard } from '../ReviewCard';

afterEach(() => {
  document.body.replaceChildren();
});

it('names the review dialog, contains keyboard focus, cancels on Escape, and restores focus', () => {
  const onClose = vi.fn();
  const onConfirmSend = vi.fn();
  const renderTree = (open: boolean) => (
    <>
      <button type="button">Review transaction</button>
      <ReviewCard
        open={open}
        review={{ rawTx: '00', feeSats: 1, totalSats: 1, finalOutputs: [] }}
        recipient="bitcoincash:qexample"
        assetType="bch"
        amountBch="0.1"
        fiatSummary={{ amountUsd: 0, feeUsd: 0, totalUsd: 0 }}
        selectedCategory=""
        tokenMeta={{}}
        displayNameFor={(category) => category}
        selectedForTx={[]}
        rawHexLen={2}
        isSending={false}
        onClose={onClose}
        onConfirmSend={onConfirmSend}
      />
    </>
  );

  const { rerender } = render(
    <button type="button">Review transaction</button>
  );
  const trigger = screen.getByRole('button', { name: 'Review transaction' });
  trigger.focus();
  rerender(renderTree(true));

  const dialog = screen.getByRole('dialog', { name: 'send.reviewTitle' });
  const close = screen.getByRole('button', { name: 'receive.close' });
  const focusable = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  );
  const last = focusable[focusable.length - 1];

  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(last);
  fireEvent.keyDown(document, { key: 'Tab' });
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledOnce();
  expect(onConfirmSend).not.toHaveBeenCalled();

  rerender(renderTree(false));
  expect(document.activeElement).toBe(trigger);
  rerender(renderTree(true));
  fireEvent.click(screen.getByRole('button', { name: 'send.slideToConfirm' }));
  expect(onConfirmSend).toHaveBeenCalledOnce();
});

it('shows final NFT identity and authority before authorization', () => {
  const category = 'ab'.repeat(32);
  render(
    <ReviewCard
      open
      review={{
        rawTx: '00',
        feeSats: 200,
        totalSats: 1000,
        finalOutputs: [
          {
            recipientAddress: 'bchtest:zrecipient',
            amount: 800,
            token: {
              category,
              amount: 0n,
              nft: { capability: 'minting', commitment: 'cafe' },
            },
          },
        ],
      }}
      recipient="bchtest:qrecipient"
      assetType="nft"
      amountBch=""
      fiatSummary={{ amountUsd: 0, feeUsd: 0, totalUsd: 0 }}
      selectedCategory={category}
      tokenMeta={{}}
      displayNameFor={() => 'Authority token'}
      selectedForTx={[]}
      rawHexLen={2}
      isSending={false}
      onClose={vi.fn()}
      onConfirmSend={vi.fn()}
    />
  );

  expect(screen.getByText(category)).toBeInTheDocument();
  expect(screen.getByText('bchtest:zrecipient')).toBeInTheDocument();
  expect(screen.getByText('cafe')).toBeInTheDocument();
  expect(screen.getByText('assets.mintingNfts')).toBeInTheDocument();
  expect(screen.getByText('assets.mintingNftsDescription')).toBeInTheDocument();
});

it('blocks authorization when the built token output is missing', () => {
  render(
    <ReviewCard
      open
      review={{ rawTx: '00', feeSats: 1, totalSats: 1, finalOutputs: [] }}
      recipient="bchtest:qrecipient"
      assetType="nft"
      amountBch=""
      fiatSummary={{ amountUsd: 0, feeUsd: 0, totalUsd: 0 }}
      selectedCategory={'ab'.repeat(32)}
      tokenMeta={{}}
      displayNameFor={() => 'NFT'}
      selectedForTx={[]}
      rawHexLen={2}
      isSending={false}
      onClose={vi.fn()}
      onConfirmSend={vi.fn()}
    />
  );

  expect(screen.getByRole('alert')).toHaveTextContent(
    'built transaction does not contain the selected CashToken output'
  );
  expect(
    screen.getByRole('button', { name: 'send.slideToConfirm' })
  ).toBeDisabled();
});
