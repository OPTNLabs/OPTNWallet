import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { FaBitcoin } from 'react-icons/fa';
import { RootState } from '../state/store';
import PageHeader from '../components/ui/PageHeader';
import SectionCard from '../components/ui/SectionCard';
import SectionHeader from '../components/ui/SectionHeader';
import EmptyState from '../components/ui/EmptyState';
import { SATSINBITCOIN } from '../utils/constants';
import useSharedTokenMetadata from '../hooks/useSharedTokenMetadata';
import { Network } from '../state/slices/networkSlice';
import TokenIdentityBadge from '../components/ui/TokenIdentityBadge';
import Popup from '../components/transaction/Popup';
import TokenQuery from '../components/TokenQuery';
import WalletScreen from '../components/ui/WalletScreen';
import TransactionService from '../services/TransactionService';
import type { ContractAddressRecord, UTXO } from '../types/types';
import useFetchWalletData from '../hooks/useFetchWalletData';
import UTXOService from '../services/UTXOService';
import { logError } from '../utils/errorHandling';
import type { TokenPresentationFallback } from '../utils/tokenPresentation';
import { StealthBalanceCard } from '../features/rpa/StealthBalanceCard';
import { CauldronActivityCard } from '../features/cauldron/CauldronActivityCard';
import { dedupeTokenUtxos, getStableTokenUtxos } from './assetsTokenInventory';
import type { TokenCapability } from '../services/cashtokens';
import {
  formatAtomicTokenAmount,
  resolveTokenPresentation,
} from '../utils/tokenPresentation';
import { useI18n } from '../i18n/useI18n';
import { formatNumber } from '../i18n/format';

type AssetTab = 'BCH' | 'Tokens' | 'NFTs';
const isDev = import.meta.env.DEV;

const Assets: React.FC = () => {
  const navigate = useNavigate();
  const { locale, t } = useI18n();
  const [tab, setTab] = useState<AssetTab>('BCH');
  const [selectedTokenCategory, setSelectedTokenCategory] = useState<
    string | null
  >(null);
  const currentWalletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const reduxUTXOs = useSelector((state: RootState) => state.utxos.utxos);
  const totalBalance = useSelector(
    (state: RootState) => state.utxos.totalBalance
  );
  const currentNetwork = useSelector(
    (state: RootState) => state.network.currentNetwork
  );
  const bchUsdQuote = useSelector(
    (state: RootState) => state.priceFeed['BCH-USD']?.price
  );
  const [displayMode, setDisplayMode] = useState<'BCH' | 'USD'>('BCH');
  const [walletAddresses, setWalletAddresses] = useState<
    { address: string; tokenAddress: string }[]
  >([]);
  const [, setWalletContractAddresses] = useState<ContractAddressRecord[]>([]);
  const [, setWalletContractUtxos] = useState<UTXO[]>([]);
  const [, setDefaultChangeAddress] = useState<string>('');
  const [, setWalletError] = useState<string | null>(null);
  const [walletUtxos, setWalletUtxos] = useState<UTXO[]>([]);
  const [refreshedTokenUtxos, setRefreshedTokenUtxos] = useState<UTXO[]>([]);
  const reduxTokenUtxos = useMemo(
    () => dedupeTokenUtxos(Object.values(reduxUTXOs).flat()),
    [reduxUTXOs]
  );
  const walletTokenUtxos = useMemo(
    () => dedupeTokenUtxos(walletUtxos),
    [walletUtxos]
  );
  const tokenUtxos = useMemo(
    () =>
      currentWalletId
        ? getStableTokenUtxos(
            // The worker's Redux snapshot is refreshed by address
            // notifications and block events. Prefer it when available so
            // externally received mempool tokens can replace this page's
            // older local snapshot without forcing a database read on every
            // render. Keep the local/native snapshots as fallbacks while the
            // worker is loading or a refresh fails.
            reduxTokenUtxos,
            refreshedTokenUtxos,
            walletTokenUtxos
          )
        : [],
    [currentWalletId, refreshedTokenUtxos, walletTokenUtxos, reduxTokenUtxos]
  );

  useFetchWalletData(
    currentWalletId,
    setWalletAddresses,
    setWalletContractAddresses,
    setWalletUtxos,
    setWalletContractUtxos,
    setDefaultChangeAddress,
    setWalletError
  );

  useEffect(() => {
    setRefreshedTokenUtxos([]);
  }, [currentWalletId]);

  useEffect(() => {
    let cancelled = false;

    async function loadNativeTokenInventory(): Promise<void> {
      if (!currentWalletId) return;

      if (walletAddresses.length === 0) {
        // Keep the last known token rows visible while the refreshed address
        // list is still loading. Clearing here makes token holdings appear to
        // disappear on every reload before the DB snapshot is restored.
        return;
      }

      try {
        await UTXOService.fetchAndStoreUTXOsMany(
          currentWalletId,
          walletAddresses.map((item) => item.address)
        );
        const nativeWalletUtxos =
          await UTXOService.fetchAllWalletUtxos(currentWalletId);
        let nextTokenUtxos = nativeWalletUtxos.tokenUtxos ?? [];

        if (isDev) {
          console.log('[Assets] native inventory snapshot', {
            walletId: currentWalletId,
            addressCount: walletAddresses.length,
            addressSample: walletAddresses.slice(0, 3),
            allUtxoCount: nativeWalletUtxos.allUtxos.length,
            tokenUtxoCount: nativeWalletUtxos.tokenUtxos.length,
            tokenCategories: nativeWalletUtxos.tokenUtxos
              .map((utxo) => utxo.token?.category)
              .filter(Boolean),
          });
        }

        if (nextTokenUtxos.length === 0) {
          const fallbackSnapshot =
            await TransactionService.fetchAddressesAndUTXOs(currentWalletId);
          nextTokenUtxos = (fallbackSnapshot.utxos ?? []).filter(
            (utxo) => !!utxo.token
          );

          if (isDev) {
            console.log('[Assets] fallback inventory snapshot', {
              walletId: currentWalletId,
              fallbackUtxoCount: fallbackSnapshot.utxos.length,
              fallbackTokenUtxoCount: nextTokenUtxos.length,
              fallbackTokenCategories: nextTokenUtxos
                .map((utxo) => utxo.token?.category)
                .filter(Boolean),
            });
          }
        }

        if (cancelled) return;
        setRefreshedTokenUtxos(dedupeTokenUtxos(nextTokenUtxos));

        if (isDev) {
          console.log('[Assets] grouped token rows', {
            walletId: currentWalletId,
            groupedCount: nextTokenUtxos.length,
            groupedCategories: nextTokenUtxos.map(
              (utxo) => utxo.token?.category
            ),
          });
        }
      } catch (error) {
        logError('Assets.loadNativeTokenInventory', error, {
          walletId: currentWalletId,
        });
        // Preserve the previous token snapshot on fetch errors. The DB-backed
        // state is still the safer source of truth than blanking the list.
      }
    }

    void loadNativeTokenInventory();
    return () => {
      cancelled = true;
    };
  }, [currentWalletId, walletAddresses]);

  const entries = useMemo(() => {
    const tokenTotals: Record<
      string,
      { amount: bigint; decimals: number; nft: boolean }
    > = {};

    for (const utxo of tokenUtxos) {
      const token = utxo.token;
      const category = token?.category;
      if (!category) continue;
      const amount =
        typeof token.amount === 'bigint'
          ? token.amount
          : BigInt(Math.trunc(Number(token.amount ?? 0) || 0));
      const decimals = token.BcmrTokenMetadata?.token?.decimals ?? 0;
      const nft = !!token.nft;
      const current = tokenTotals[category] ?? { amount: 0n, decimals, nft };
      tokenTotals[category] = {
        amount: current.amount + amount,
        decimals: current.decimals || decimals,
        nft: current.nft || nft,
      };
    }

    return Object.entries(tokenTotals);
  }, [tokenUtxos]);
  const tokenCategories = useMemo(
    () => entries.map(([category]) => category),
    [entries]
  );
  const fungibleTokens = entries.filter(([, value]) => value.amount > 0n);
  const nftTokens = entries.filter(([, value]) => value.nft);
  const nftGroups = useMemo(() => {
    const groups: Record<TokenCapability, Record<string, number>> = {
      none: {},
      mutable: {},
      minting: {},
    };

    for (const utxo of tokenUtxos) {
      const category = utxo.token?.category;
      const capability = utxo.token?.nft?.capability;
      if (!category || !capability) continue;
      groups[capability][category] = (groups[capability][category] ?? 0) + 1;
    }

    return groups;
  }, [tokenUtxos]);
  const tokenMetadata = useSharedTokenMetadata(tokenCategories);
  const tokenFallbackByCategory = useMemo(() => {
    const byCategory = new Map<string, TokenPresentationFallback>();

    for (const utxo of tokenUtxos) {
      const category = utxo.token?.category;
      const bcmr = utxo.token?.BcmrTokenMetadata;
      if (!category || !bcmr || byCategory.has(category)) continue;

      byCategory.set(category, {
        name: bcmr.name,
        symbol: bcmr.token.symbol,
        decimals: bcmr.token.decimals,
        iconUri: bcmr.uris?.icon ?? null,
      });
    }

    return byCategory;
  }, [tokenUtxos]);
  const selectedTokenMetadata = selectedTokenCategory
    ? tokenMetadata[selectedTokenCategory]
    : null;
  const totalBch = totalBalance / SATSINBITCOIN;
  const totalUsd =
    typeof bchUsdQuote === 'number' ? totalBch * bchUsdQuote : null;
  const formattedBch = formatNumber(totalBch, locale, {
    minimumFractionDigits: 8,
    maximumFractionDigits: 8,
  });
  const formattedUsd =
    totalUsd !== null
      ? formatNumber(totalUsd, locale, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })
      : null;

  useEffect(() => {
    if (!isDev) return;
    console.log('[Assets] render summary', {
      walletId: currentWalletId,
      tab,
      walletAddresses: walletAddresses.length,
      tokenUtxos: tokenUtxos.length,
      groupedEntries: entries.length,
      fungibleTokens: fungibleTokens.length,
      nftTokens: nftTokens.length,
      categories: tokenCategories,
    });
  }, [
    currentWalletId,
    tab,
    walletAddresses.length,
    tokenUtxos.length,
    entries,
    fungibleTokens.length,
    nftTokens.length,
    tokenCategories,
  ]);

  return (
    <WalletScreen maxWidthClassName="max-w-md" scrollable={false}>
      <div className="flex h-full min-h-0 flex-col gap-3">
        <PageHeader
          title={t('assets.title')}
          subtitle={
            currentNetwork === Network.CHIPNET ? t('assets.chipnet') : ''
          }
          compact
        />

        <SectionCard className="shrink-0 p-3">
          <div className="grid grid-cols-3 gap-2">
            {(['BCH', 'Tokens', 'NFTs'] as AssetTab[]).map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => setTab(name)}
                className={`rounded-2xl border px-3 py-2 text-sm font-semibold transition ${
                  tab === name
                    ? 'wallet-segment-active border-[var(--wallet-accent)]'
                    : 'wallet-segment-inactive border-[var(--wallet-border)]'
                }`}
              >
                {name === 'BCH'
                  ? t('assets.tabBch')
                  : name === 'Tokens'
                    ? t('assets.tabTokens')
                    : t('assets.tabNfts')}
              </button>
            ))}
          </div>
        </SectionCard>

        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain pr-1">
          {tab === 'BCH' && (
            <div className="flex h-full min-h-0 flex-col gap-3">
              <SectionCard className="p-3">
                <SectionHeader
                  title={t('assets.bitcoinCash')}
                  subtitle={t('assets.primaryBalance')}
                  compact
                />
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <button
                      type="button"
                      onClick={() =>
                        setDisplayMode((mode) =>
                          mode === 'BCH' ? 'USD' : 'BCH'
                        )
                      }
                      className="text-left"
                    >
                      <div className="text-2xl font-bold wallet-text-strong">
                        {displayMode === 'BCH'
                          ? `${formattedBch} BCH`
                          : formattedUsd !== null
                            ? `$${formattedUsd} USD`
                            : t('assets.usdUnavailable')}
                      </div>
                      <div className="text-xs wallet-muted">
                        {displayMode === 'BCH'
                          ? formattedUsd !== null
                            ? `$${formattedUsd} USD`
                            : t('assets.usdPriceUnavailable')
                          : `${formattedBch} BCH`}
                      </div>
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setDisplayMode((mode) => (mode === 'BCH' ? 'USD' : 'BCH'))
                    }
                    className="flex h-14 w-14 items-center justify-center rounded-3xl bg-[color-mix(in_oklab,var(--wallet-accent-soft)_72%,transparent)] text-[var(--wallet-accent-strong)] transition hover:brightness-[1.04]"
                    aria-label={t('assets.toggleBalance')}
                  >
                    <FaBitcoin className="text-2xl" />
                  </button>
                </div>
              </SectionCard>

              <StealthBalanceCard walletId={currentWalletId} />
              <CauldronActivityCard walletId={currentWalletId} />

              <SectionCard className="p-3">
                <SectionHeader
                  title={t('assets.cashTokenHoldings')}
                  subtitle={t('assets.quickInventory')}
                  compact
                />
                <div className="grid grid-cols-3 gap-2.5">
                  <div className="wallet-card p-3 text-left">
                    <div className="text-lg font-bold wallet-text-strong">
                      {fungibleTokens.length}
                    </div>
                    <div className="text-xs wallet-muted">
                      {t('assets.fungible')}
                    </div>
                  </div>
                  <div className="wallet-card p-3 text-left">
                    <div className="text-lg font-bold wallet-text-strong">
                      {nftTokens.length}
                    </div>
                    <div className="text-xs wallet-muted">
                      {t('assets.nfts')}
                    </div>
                  </div>
                  <div className="wallet-card p-3 text-left">
                    <div className="text-lg font-bold wallet-text-strong">
                      {entries.length}
                    </div>
                    <div className="text-xs wallet-muted">
                      {t('assets.categories')}
                    </div>
                  </div>
                </div>
              </SectionCard>
            </div>
          )}

          {tab === 'Tokens' && (
            <div className="flex h-full min-h-0 flex-col gap-2.5">
              <SectionCard className="min-h-0 flex-1 overflow-hidden p-3">
                <SectionHeader
                  title={t('assets.cashTokens')}
                  subtitle={t('assets.fungibleHoldings')}
                  compact
                />
                <div className="h-full min-h-0 space-y-2.5 overflow-y-auto overscroll-contain pb-[calc(var(--safe-bottom)+1rem)] pr-1">
                  {fungibleTokens.length > 0 ? (
                    fungibleTokens.map(([category, value]) => {
                      const metadata = tokenMetadata[category];
                      const presentation = resolveTokenPresentation(
                        category,
                        metadata,
                        tokenFallbackByCategory.get(category) ?? null
                      );
                      const displayAmount = formatAtomicTokenAmount(
                        value.amount,
                        presentation.decimals
                      );
                      return (
                        <button
                          key={category}
                          type="button"
                          className="wallet-card w-full p-2.5 text-left transition hover:brightness-[0.98]"
                          onClick={() => setSelectedTokenCategory(category)}
                        >
                          <div className="flex items-center gap-2.5">
                            <TokenIdentityBadge
                              presentation={presentation}
                              className="flex-1"
                              avatarClassName="h-9 w-9"
                              primaryClassName="text-sm"
                              secondaryClassName="text-xs"
                              detail={
                                <div className="shrink-0 text-right">
                                  <div className="text-sm font-semibold wallet-text-strong">
                                    {displayAmount}
                                  </div>
                                  <div className="text-xs wallet-muted">
                                    {value.amount.toString()} units
                                  </div>
                                </div>
                              }
                            />
                          </div>
                        </button>
                      );
                    })
                  ) : (
                    <EmptyState message={t('assets.noFungibleTokens')} />
                  )}
                </div>
              </SectionCard>
              <button
                type="button"
                className="wallet-btn-primary w-full py-2.5"
                onClick={() => navigate('/mint-cashtokens-poc')}
              >
                {t('assets.mintTokens')}
              </button>
            </div>
          )}

          {tab === 'NFTs' && (
            <div className="flex h-full min-h-0 flex-col gap-2.5">
              <SectionCard className="min-h-0 flex-1 overflow-hidden p-3">
                <SectionHeader
                  title={t('assets.tabNfts')}
                  subtitle={t('assets.nonFungibleHoldings')}
                  compact
                />
                <div className="h-full min-h-0 space-y-2.5 overflow-y-auto overscroll-contain pb-[calc(var(--safe-bottom)+1rem)] pr-1">
                  {nftTokens.length > 0 ? (
                    (['none', 'mutable', 'minting'] as TokenCapability[]).map(
                      (capability) => {
                        const groupEntries = Object.entries(
                          nftGroups[capability]
                        );
                        if (groupEntries.length === 0) return null;
                        const title =
                          capability === 'none'
                            ? t('assets.plainNfts')
                            : capability === 'mutable'
                              ? t('assets.mutableNfts')
                              : t('assets.mintingNfts');
                        const subtitle =
                          capability === 'none'
                            ? t('assets.plainNftsDescription')
                            : capability === 'mutable'
                              ? t('assets.mutableNftsDescription')
                              : t('assets.mintingNftsDescription');
                        return (
                          <div key={capability} className="space-y-2">
                            <div className="px-1">
                              <div className="text-sm font-semibold wallet-text-strong">
                                {title}
                              </div>
                              <div className="text-xs wallet-muted">
                                {subtitle}
                              </div>
                            </div>
                            {groupEntries.map(([category]) => {
                              const metadata = tokenMetadata[category];
                              const presentation = resolveTokenPresentation(
                                category,
                                metadata,
                                tokenFallbackByCategory.get(category) ?? null
                              );
                              return (
                                <button
                                  key={category}
                                  type="button"
                                  className="wallet-card w-full p-2.5 text-left transition hover:brightness-[0.98]"
                                  onClick={() =>
                                    setSelectedTokenCategory(category)
                                  }
                                >
                                  <div className="flex items-center gap-2.5">
                                    <TokenIdentityBadge
                                      presentation={presentation}
                                      className="flex-1"
                                      avatarClassName="h-9 w-9"
                                      primaryClassName="text-sm"
                                      secondaryClassName="text-xs"
                                    />
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        );
                      }
                    )
                  ) : (
                    <EmptyState message={t('assets.noNfts')} />
                  )}
                </div>
              </SectionCard>
              <button
                type="button"
                className="wallet-btn-primary w-full py-2.5"
                onClick={() => navigate('/mint-cashtokens-poc')}
              >
                {t('assets.mintTokens')}
              </button>
            </div>
          )}
        </div>

        {tab === 'BCH' && (
          <SectionCard className="shrink-0 p-3">
            <SectionHeader
              title={t('assets.quantumroot')}
              compact
              action={
                <button
                  type="button"
                  onClick={() => navigate('/quantumroot')}
                  className="wallet-btn-secondary px-3 py-1.5 text-sm"
                >
                  {t('assets.openVaults')}
                </button>
              }
            />
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold wallet-text-strong">
                  {currentNetwork === Network.CHIPNET
                    ? t('assets.advancedVaultWorkspace')
                    : t('assets.vaultWorkspace')}
                </div>
                <div className="text-xs wallet-muted">
                  {t('assets.advancedVaultDescription')}
                </div>
              </div>
            </div>
          </SectionCard>
        )}
      </div>
      {selectedTokenCategory && (
        <Popup closePopups={() => setSelectedTokenCategory(null)}>
          <div className="max-h-[75vh] overflow-y-auto pr-1">
            <TokenQuery
              tokenId={selectedTokenCategory}
              prefetchedSnapshot={selectedTokenMetadata?.snapshot ?? null}
              prefetchedIconDataUri={
                selectedTokenMetadata?.status === 'ready'
                  ? selectedTokenMetadata.iconUri
                  : null
              }
            />
          </div>
        </Popup>
      )}
    </WalletScreen>
  );
};

export default Assets;
