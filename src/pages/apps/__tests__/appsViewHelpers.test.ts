import { describe, expect, it } from 'vitest';
import {
  compareAppsForBrowse,
  groupAppsByCategory,
  getAppCategory,
  getAppDescription,
  getAppIconFrame,
  getAppSortPriority,
  isComingSoonApp,
  shouldHideApp,
} from '../appsViewHelpers';

describe('appsViewHelpers', () => {
  it('keeps the existing category routing rules', () => {
    expect(
      getAppCategory({ id: 'optn.wallet.contracts', name: 'Contracts' })
    ).toBe('Wallet');
    expect(
      getAppCategory({
        id: 'optn.builtin.paper-wallet-sweep:paperWalletSweepApp',
        name: 'Paper Wallet',
      })
    ).toBe('Wallet');
    expect(
      getAppCategory({
        id: 'optn.builtin.merchant-pay:merchantPayApp',
        name: 'Merchant Pay',
      })
    ).toBe('Wallet');
    expect(
      getAppCategory({
        id: 'optn.builtin.mint:mintCashTokensPoCApp',
        name: 'CashTokens',
      })
    ).toBe('Token');
    expect(
      getAppCategory({
        id: 'optn.builtin.paryon:paryonWorkspaceApp',
        name: 'ParyonUSD',
      })
    ).toBe('Token');
    expect(
      getAppCategory({
        id: 'optn.builtin.events:airdropsApp',
        name: 'Airdrops',
      })
    ).toBe('Utils');
    expect(
      getAppCategory({ id: 'optn.builtin.fundme:fundmeApp', name: 'FundMe' })
    ).toBe('Advanced');
    expect(
      getAppCategory({
        id: 'optn.builtin.cauldron:cauldronSwapApp',
        name: 'Cauldron',
      })
    ).toBe('Advanced');
  });

  it('groups the browse surface in task-first category order', () => {
    const groups = groupAppsByCategory([
      { id: 'utils', category: 'Utils' as const },
      { id: 'advanced', category: 'Advanced' as const },
      { id: 'wallet', category: 'Wallet' as const },
      { id: 'token', category: 'Token' as const },
    ]);

    expect(groups.map((group) => group.category)).toEqual([
      'Wallet',
      'Token',
      'Utils',
      'Advanced',
    ]);
    expect(groups.every((group) => group.apps)).toBe(true);
  });

  it('keeps the existing sort priorities and add-on descriptions', () => {
    expect(
      getAppSortPriority({ id: 'optn.wallet.contracts', name: 'Contracts' })
    ).toBe(0);
    expect(
      getAppSortPriority({
        id: 'optn.builtin.events:airdropsApp',
        name: 'Airdrops',
      })
    ).toBe(0);
    expect(
      getAppSortPriority({
        id: 'optn.builtin.cauldron:cauldronSwapApp',
        name: 'Cauldron',
      })
    ).toBe(1);
    expect(
      getAppSortPriority({
        id: 'optn.builtin.merchant-pay:merchantPayApp',
        name: 'Merchant Pay',
      })
    ).toBe(1);
    expect(
      getAppDescription({
        id: 'optn.builtin.cauldron:cauldronSwapApp',
        name: 'Cauldron',
        description: 'x',
      })
    ).toBe('x');
  });

  it('keeps the existing icon-frame and hidden-app rules', () => {
    expect(getAppIconFrame({ name: 'WalletConnect' })).toContain(
      'bg-sky-500/15'
    );
    expect(shouldHideApp('optn.builtin.demo:authguard', 'AuthGuard')).toBe(
      true
    );
    expect(
      shouldHideApp('optn.builtin.cauldron:cauldronSwapApp', 'Cauldron')
    ).toBe(false);
    expect(
      shouldHideApp('optn.builtin.merchant-pay:merchantPayApp', 'Merchant Pay')
    ).toBe(false);
  });

  it('marks unreleased app surfaces as coming soon', () => {
    expect(isComingSoonApp('optn.builtin.fundme:fundmeApp', 'FundMe')).toBe(
      true
    );
    expect(
      isComingSoonApp('optn.builtin.paryon:paryonWorkspaceApp', 'ParyonUSD')
    ).toBe(true);
    expect(
      isComingSoonApp('optn.builtin.demo:merchantPayApp', 'Merchant Pay')
    ).toBe(false);
    expect(
      isComingSoonApp('optn.builtin.cauldron:cauldronSwapApp', 'Cauldron')
    ).toBe(false);
  });

  it('sorts apps alphabetically with coming soon apps last regardless of locale', () => {
    const ordered = [
      { name: 'Quantumroot', comingSoon: false, disabled: false },
      { name: 'Cauldron', comingSoon: false, disabled: false },
      { name: 'ParyonUSD', comingSoon: true, disabled: true },
      { name: 'FundMe', comingSoon: true, disabled: true },
      { name: 'Contracts', comingSoon: false, disabled: false },
      { name: 'Airdrops', comingSoon: false, disabled: false },
    ].sort(compareAppsForBrowse);

    expect(ordered.map((app) => app.name)).toEqual([
      'Airdrops',
      'Cauldron',
      'Contracts',
      'Quantumroot',
      'FundMe',
      'ParyonUSD',
    ]);
  });
});
