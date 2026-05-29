import { describe, expect, it } from 'vitest';
import {
  getAppCategory,
  getAppDescription,
  getAppIconFrame,
  getAppSortPriority,
  isComingSoonApp,
  shouldHideApp,
} from '../appsViewHelpers';

describe('appsViewHelpers', () => {
  it('keeps the existing category routing rules', () => {
    expect(getAppCategory({ id: 'optn.wallet.contracts', name: 'Contracts' })).toBe('Wallet');
    expect(getAppCategory({ id: 'optn.builtin.paper-wallet-sweep:paperWalletSweepApp', name: 'Paper Wallet' })).toBe('Wallet');
    expect(getAppCategory({ id: 'optn.builtin.mint:mintCashTokensPoCApp', name: 'Mint Tokens' })).toBe('Token');
    expect(getAppCategory({ id: 'optn.builtin.paryon:paryonWorkspaceApp', name: 'ParyonUSD' })).toBe('Token');
    expect(getAppCategory({ id: 'optn.builtin.events:airdropsApp', name: 'Airdrops' })).toBe('Utils');
    expect(getAppCategory({ id: 'optn.builtin.fundme:fundmeApp', name: 'FundMe' })).toBe('Advanced');
    expect(getAppCategory({ id: 'optn.builtin.cauldron:cauldronSwapApp', name: 'Cauldron' })).toBe('Advanced');
  });

  it('keeps the existing sort priorities and descriptions', () => {
    expect(getAppSortPriority({ id: 'optn.wallet.contracts', name: 'Contracts' })).toBe(0);
    expect(getAppSortPriority({ id: 'optn.builtin.events:airdropsApp', name: 'Airdrops' })).toBe(0);
    expect(getAppSortPriority({ id: 'optn.builtin.cauldron:cauldronSwapApp', name: 'Cauldron' })).toBe(1);
    expect(getAppDescription({ id: 'optn.builtin.cauldron:cauldronSwapApp', name: 'Cauldron', description: 'x' })).toBe('Swap BCH and CashTokens');
  });

  it('keeps the existing icon-frame and hidden-app rules', () => {
    expect(getAppIconFrame({ name: 'WalletConnect' })).toContain('bg-sky-500/15');
    expect(shouldHideApp('optn.builtin.demo:authguard', 'AuthGuard')).toBe(true);
    expect(shouldHideApp('optn.builtin.cauldron:cauldronSwapApp', 'Cauldron')).toBe(false);
  });

  it('only marks FundMe and ParyonUSD as coming soon outside dev mode', () => {
    expect(isComingSoonApp('optn.builtin.fundme:fundmeApp', 'FundMe')).toBe(true);
    expect(
      isComingSoonApp('optn.builtin.paryon:paryonWorkspaceApp', 'ParyonUSD')
    ).toBe(true);
    expect(isComingSoonApp('optn.builtin.cauldron:cauldronSwapApp', 'Cauldron')).toBe(
      false
    );
  });
});
