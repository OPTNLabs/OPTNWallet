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
import type { ContractAddressRecord, UTXO } from '../types/types';
import useFetchWalletData from '../hooks/useFetchWalletData';
import type { TokenPresentationFallback } from '../utils/tokenPresentation';
import { StealthBalanceCard } from '../features/rpa/StealthBalanceCard';
import { CauldronActivityCard } from '../features/cauldron/CauldronActivityCard';
import {
  buildNftCardModels,
  dedupeTokenUtxos,
  getStableTokenUtxos,
  summarizeNftInstances,
} from './assetsTokenInventory';
import type { NftCategory } from '@bitauth/libauth';
import { resolveParyonNftParseInfo } from '../services/paryon/nftRegistry';
import type { NftParseInfo } from '../services/nftParsing/nftParsing';
import {
  formatAtomicTokenAmount,
  resolveTokenPresentation,
} from '../utils/tokenPresentation';
import { useI18n } from '../i18n/useI18n';

type AssetTab = 'BCH' | 'Tokens' | 'NFTs';
const isDev = import.meta.env.DEV;

type AssetsProps = {
  viewerOnly?: boolean;
};

const Assets: React.FC<AssetsProps> = ({ viewerOnly = false }) => {
  const navigate = useNavigate();
  const { t } = useI18n();
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
        ? getStableTokenUtxos(walletTokenUtxos, reduxTokenUtxos)
        : [],
    [currentWalletId, walletTokenUtxos, reduxTokenUtxos]
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

  // The shared worker already refreshes every tracked address and publishes
  // the authoritative Redux UTXO snapshot. Assets must not start a second
  // wallet-wide listunspent pass just because its route mounted.

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
  const nftInstances = useMemo(
    () => summarizeNftInstances(tokenUtxos),
    [tokenUtxos]
  );
  const nftCardMetadata = useMemo(() => {
    const byCategory: Record<
      string,
      { symbol: string; nfts: NftCategory | undefined }
    > = {};
    for (const instance of nftInstances) {
      if (byCategory[instance.category]) continue;
      const metadata = tokenMetadata[instance.category];
      const fallback = tokenFallbackByCategory.get(instance.category);
      byCategory[instance.category] = {
        symbol: metadata?.symbol || fallback?.symbol || '',
        nfts: metadata?.snapshot?.token?.nfts,
      };
    }
    return byCategory;
  }, [nftInstances, tokenMetadata, tokenFallbackByCategory]);
  const nftCards = useMemo(() => {
    // Categories without BCMR metadata fall back to the bundled ParyonUSD
    // type registry (loan and loan-key NFTs have no per-category registry).
    const familyParseInfoByCategory: Record<string, NftParseInfo> = {};
    for (const instance of nftInstances) {
      if (familyParseInfoByCategory[instance.category]) continue;
      if (nftCardMetadata[instance.category]?.nfts) continue;
      const familyParseInfo = resolveParyonNftParseInfo(
        currentNetwork,
        instance.category
      );
      if (familyParseInfo) {
        familyParseInfoByCategory[instance.category] = familyParseInfo;
      }
    }
    return buildNftCardModels(
      nftInstances,
      nftCardMetadata,
      familyParseInfoByCategory
    );
  }, [nftInstances, nftCardMetadata, currentNetwork]);
  const totalBch = totalBalance / SATSINBITCOIN;
  const totalUsd =
    typeof bchUsdQuote === 'number' ? totalBch * bchUsdQuote : null;

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
                          ? `${totalBch.toFixed(8)} BCH`
                          : totalUsd !== null
                            ? `$${totalUsd.toFixed(2)} USD`
                            : t('assets.usdUnavailable')}
                      </div>
                      <div className="text-xs wallet-muted">
                        {displayMode === 'BCH'
                          ? totalUsd !== null
                            ? `$${totalUsd.toFixed(2)} USD`
                            : t('assets.usdPriceUnavailable')
                          : `${totalBch.toFixed(8)} BCH`}
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

              {!viewerOnly && (
                <>
                  <StealthBalanceCard walletId={currentWalletId} />
                  <CauldronActivityCard walletId={currentWalletId} />
                </>
              )}

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
                                    {value.amount.toString()}{' '}
                                    {t('assets.units')}
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
              {!viewerOnly && (
                <button
                  type="button"
                  className="wallet-btn-primary w-full py-2.5"
                  onClick={() => navigate('/mint-cashtokens-poc')}
                >
                  {t('assets.mintTokens')}
                </button>
              )}
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
                  {nftCards.length > 0 ? (
                    nftCards.map((card) => {
                      const presentation = resolveTokenPresentation(
                        card.category,
                        tokenMetadata[card.category],
                        tokenFallbackByCategory.get(card.category) ?? null
                      );
                      return (
                        <button
                          key={card.outpoint}
                          type="button"
                          className="wallet-card w-full p-2.5 text-left transition hover:brightness-[0.98]"
                          onClick={() =>
                            setSelectedTokenCategory(card.category)
                          }
                        >
                          <div className="flex items-center gap-2.5">
                            {card.imageUri ? (
                              <img
                                src={card.imageUri}
                                alt={card.primaryLabel}
                                className="h-9 w-9 shrink-0 rounded-lg border border-[var(--wallet-border)] object-cover"
                              />
                            ) : null}
                            <TokenIdentityBadge
                              presentation={presentation}
                              className="flex-1"
                              avatarClassName="h-9 w-9"
                              primaryClassName="text-sm"
                              secondaryClassName="text-xs"
                              detail={
                                <div className="shrink-0 text-right">
                                  <div className="text-sm font-semibold wallet-text-strong">
                                    {card.primaryLabel}
                                  </div>
                                  <div className="text-xs wallet-muted">
                                    {card.parsed
                                      ? card.fields.length === 1
                                        ? '1 field'
                                        : `${card.fields.length} fields`
                                      : 'unparsed'}
                                  </div>
                                </div>
                              }
                            />
                          </div>
                          {card.fields.length > 0 ? (
                            <div className="mt-2 space-y-1 border-t border-[var(--wallet-border)] pt-2">
                              {card.fields.map((field, index) => (
                                <div
                                  key={index}
                                  className="flex items-baseline justify-between gap-2 text-xs"
                                >
                                  <span className="wallet-muted">
                                    {field.name ??
                                      field.fieldId ??
                                      `field ${index}`}
                                  </span>
                                  <span className="wallet-text-strong font-mono">
                                    {field.parsedValue?.formatted ??
                                      field.value}
                                  </span>
                                </div>
                              ))}
                            </div>
                          ) : null}
                          {!card.parsed && card.parseError ? (
                            <p className="mt-1 truncate text-[10px] wallet-danger-text">
                              {card.parseError}
                            </p>
                          ) : null}
                        </button>
                      );
                    })
                  ) : (
                    <EmptyState message={t('assets.noNfts')} />
                  )}
                </div>
              </SectionCard>
              {!viewerOnly && (
                <button
                  type="button"
                  className="wallet-btn-primary w-full py-2.5"
                  onClick={() => navigate('/mint-cashtokens-poc')}
                >
                  {t('assets.mintTokens')}
                </button>
              )}
            </div>
          )}
        </div>

        {!viewerOnly && tab === 'BCH' && (
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
