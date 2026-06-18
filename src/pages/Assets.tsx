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
import type { UTXO } from '../types/types';
import useFetchWalletData from '../hooks/useFetchWalletData';
import UTXOService from '../services/UTXOService';
import { logError } from '../utils/errorHandling';
import type { TokenPresentationFallback } from '../utils/tokenPresentation';
import {
  dedupeTokenUtxos,
  getStableTokenUtxos,
  summarizeNftInstances,
} from './assetsTokenInventory';
import {
  formatAtomicTokenAmount,
  resolveTokenPresentation,
} from '../utils/tokenPresentation';
import { shortenHash } from '../utils/shortenHash';

type AssetTab = 'BCH' | 'Tokens' | 'NFTs';
const isDev = import.meta.env.DEV;

const Assets: React.FC = () => {
  const navigate = useNavigate();
  const [tab, setTab] = useState<AssetTab>('BCH');
  const [selectedTokenCategory, setSelectedTokenCategory] = useState<string | null>(null);
  const currentWalletId = useSelector((state: RootState) => state.wallet_id.currentWalletId);
  const reduxUTXOs = useSelector((state: RootState) => state.utxos.utxos);
  const totalBalance = useSelector((state: RootState) => state.utxos.totalBalance);
  const currentNetwork = useSelector((state: RootState) => state.network.currentNetwork);
  const bchUsdQuote = useSelector((state: RootState) => state.priceFeed['BCH-USD']?.price);
  const [displayMode, setDisplayMode] = useState<'BCH' | 'USD'>('BCH');
  const [walletAddresses, setWalletAddresses] = useState<
    { address: string; tokenAddress: string }[]
  >([]);
  const [, setWalletContractAddresses] = useState<unknown[]>([]);
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
            refreshedTokenUtxos,
            walletTokenUtxos,
            reduxTokenUtxos
          )
        : [],
    [currentWalletId, refreshedTokenUtxos, walletTokenUtxos, reduxTokenUtxos]
  );
  const nftInstances = useMemo(
    () => summarizeNftInstances(tokenUtxos),
    [tokenUtxos]
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
        const nativeWalletUtxos = await UTXOService.fetchAllWalletUtxos(currentWalletId);
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
          const fallbackSnapshot = await TransactionService.fetchAddressesAndUTXOs(
            currentWalletId
          );
          nextTokenUtxos = (fallbackSnapshot.utxos ?? []).filter((utxo) => !!utxo.token);

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
        logError('Assets.loadNativeTokenInventory', error, { walletId: currentWalletId });
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
      const category = utxo.token?.category;
      if (!category) continue;
      const amount =
        typeof utxo.token.amount === 'bigint'
          ? utxo.token.amount
          : BigInt(Math.trunc(Number(utxo.token.amount ?? 0) || 0));
      const decimals = utxo.token.BcmrTokenMetadata?.token?.decimals ?? 0;
      const nft = !!utxo.token.nft;
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
  const totalUsd = typeof bchUsdQuote === 'number' ? totalBch * bchUsdQuote : null;

  useEffect(() => {
    if (!isDev) return;
    console.log('[Assets] render summary', {
      walletId: currentWalletId,
      tab,
      walletAddresses: walletAddresses.length,
      tokenUtxos: tokenUtxos.length,
      groupedEntries: entries.length,
      fungibleTokens: fungibleTokens.length,
      nftInstances: nftInstances.length,
      categories: tokenCategories,
    });
  }, [currentWalletId, tab, walletAddresses.length, tokenUtxos.length, entries, fungibleTokens.length, nftInstances.length, tokenCategories]);

  function describeNftCapability(capability: 'none' | 'mutable' | 'minting') {
    switch (capability) {
      case 'mutable':
        return 'Mutable NFT';
      case 'minting':
        return 'Minting NFT';
      default:
        return 'Plain NFT';
    }
  }

  return (
    <WalletScreen maxWidthClassName="max-w-md" scrollable={false}>
      <div className="flex h-full min-h-0 flex-col gap-3">
        <PageHeader title="Assets" subtitle={currentNetwork === Network.CHIPNET ? 'Chipnet' : ''} compact />

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
                {name}
              </button>
            ))}
          </div>
        </SectionCard>

        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain pr-1">
          {tab === 'BCH' && (
            <div className="flex h-full min-h-0 flex-col gap-3">
              <SectionCard className="p-3">
              <SectionHeader title="Bitcoin Cash" subtitle="Primary wallet balance" compact />
              <div className="flex items-center justify-between gap-3">
                <div>
                  <button
                    type="button"
                    onClick={() => setDisplayMode((mode) => (mode === 'BCH' ? 'USD' : 'BCH'))}
                    className="text-left"
                  >
                    <div className="text-2xl font-bold wallet-text-strong">
                      {displayMode === 'BCH'
                        ? `${totalBch.toFixed(8)} BCH`
                        : totalUsd !== null
                          ? `$${totalUsd.toFixed(2)} USD`
                          : 'USD unavailable'}
                    </div>
                    <div className="text-xs wallet-muted">
                      {displayMode === 'BCH'
                        ? totalUsd !== null
                          ? `$${totalUsd.toFixed(2)} USD`
                          : 'USD price unavailable'
                        : `${totalBch.toFixed(8)} BCH`}
                    </div>
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setDisplayMode((mode) => (mode === 'BCH' ? 'USD' : 'BCH'))}
                  className="flex h-14 w-14 items-center justify-center rounded-3xl bg-[color-mix(in_oklab,var(--wallet-accent-soft)_72%,transparent)] text-[var(--wallet-accent-strong)] transition hover:brightness-[1.04]"
                  aria-label="Toggle BCH and USD balance"
                >
                  <FaBitcoin className="text-2xl" />
                </button>
              </div>
            </SectionCard>

              <SectionCard className="p-3">
                <SectionHeader
                  title="CashToken holdings"
                  subtitle="Quick view of your wallet inventory"
                  compact
                />
                <div className="grid grid-cols-3 gap-2.5">
                  <div className="wallet-card p-3 text-left">
                    <div className="text-lg font-bold wallet-text-strong">{fungibleTokens.length}</div>
                    <div className="text-xs wallet-muted">fungible</div>
                  </div>
                  <div className="wallet-card p-3 text-left">
                    <div className="text-lg font-bold wallet-text-strong">{nftInstances.length}</div>
                    <div className="text-xs wallet-muted">NFT UTXOs</div>
                  </div>
                  <div className="wallet-card p-3 text-left">
                    <div className="text-lg font-bold wallet-text-strong">{entries.length}</div>
                    <div className="text-xs wallet-muted">categories</div>
                  </div>
                </div>
              </SectionCard>
            </div>
          )}

          {tab === 'Tokens' && (
            <div className="flex h-full min-h-0 flex-col gap-2.5">
              <SectionCard className="min-h-0 flex-1 overflow-hidden p-3">
                <SectionHeader title="CashTokens" subtitle="Fungible token holdings" compact />
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
                    <EmptyState message="No fungible CashTokens found." />
                  )}
                </div>
              </SectionCard>
              <button
                type="button"
                className="wallet-btn-primary w-full py-2.5"
                onClick={() => navigate('/mint-cashtokens-poc')}
              >
                CashTokens
              </button>
            </div>
          )}

          {tab === 'NFTs' && (
            <div className="flex h-full min-h-0 flex-col gap-2.5">
              <SectionCard className="min-h-0 flex-1 overflow-hidden p-3">
                <SectionHeader title="NFTs" subtitle="Non-fungible holdings" compact />
                <div className="h-full min-h-0 space-y-2.5 overflow-y-auto overscroll-contain pb-[calc(var(--safe-bottom)+1rem)] pr-1">
                  {nftInstances.length > 0 ? (
                    nftInstances.map((instance) => {
                      const metadata = tokenMetadata[instance.category];
                      const presentation = resolveTokenPresentation(
                        instance.category,
                        metadata,
                        tokenFallbackByCategory.get(instance.category) ?? null
                      );
                      const commitmentLabel = instance.commitment
                        ? shortenHash(instance.commitment, 8, 6)
                        : 'empty';
                      return (
                        <button
                          key={instance.outpoint}
                          type="button"
                          className="wallet-card w-full p-2.5 text-left transition hover:brightness-[0.98]"
                          onClick={() => setSelectedTokenCategory(instance.category)}
                        >
                          <div className="flex items-center gap-2.5">
                            <TokenIdentityBadge
                              presentation={presentation}
                              className="flex-1"
                              avatarClassName="h-9 w-9"
                              primaryClassName="text-sm"
                              secondaryClassName="text-xs"
                              detail={
                                <div className="shrink-0 max-w-[10.5rem] text-right space-y-1">
                                  <div className="text-xs font-semibold wallet-text-strong">
                                    {describeNftCapability(instance.capability)}
                                  </div>
                                  <div className="text-[11px] wallet-muted break-all">
                                    Commitment {commitmentLabel}
                                  </div>
                                  <div className="text-[11px] wallet-muted break-all">
                                    Outpoint {shortenHash(instance.txHash, 8, 6)}:
                                    {instance.txPos}
                                  </div>
                                </div>
                              }
                            />
                          </div>
                        </button>
                      );
                    })
                  ) : (
                    <EmptyState message="No NFTs found." />
                  )}
                </div>
              </SectionCard>
              <button
                type="button"
                className="wallet-btn-primary w-full py-2.5"
                onClick={() => navigate('/mint-cashtokens-poc')}
              >
                CashTokens
              </button>
            </div>
          )}
        </div>

        {tab === 'BCH' && (
          <SectionCard className="shrink-0 p-3">
            <SectionHeader
              title="Quantumroot"
              compact
              action={
                <button
                  type="button"
                  onClick={() => navigate('/quantumroot')}
                  className="wallet-btn-secondary px-3 py-1.5 text-sm"
                >
                  Open vaults
                </button>
              }
            />
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold wallet-text-strong">
                  {currentNetwork === Network.CHIPNET
                    ? 'Advanced vault workspace'
                    : 'Vault workspace'}
                </div>
                <div className="text-xs wallet-muted">
                  Receive and recovery tools for advanced vaults
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
