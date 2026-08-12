import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { FaBitcoin } from 'react-icons/fa';
import { RootState } from '../redux/store';
import PageHeader from '../components/ui/PageHeader';
import SectionCard from '../components/ui/SectionCard';
import SectionHeader from '../components/ui/SectionHeader';
import EmptyState from '../components/ui/EmptyState';
import { SATSINBITCOIN } from '../utils/constants';
import { shortenTxHash } from '../utils/shortenHash';
import useSharedTokenMetadata from '../hooks/useSharedTokenMetadata';
import { Network } from '../redux/networkSlice';
import TokenAvatar from '../components/ui/TokenAvatar';
import Popup from '../components/transaction/Popup';
import TokenQuery from '../components/TokenQuery';
import { IdentitySnapshot } from '@bitauth/libauth';
import WalletScreen from '../components/ui/WalletScreen';
import QuantumrootPortfolioService from '../services/QuantumrootPortfolioService';
import TransactionService from '../services/TransactionService';
import { logError } from '../utils/errorHandling';
import type { UTXO } from '../types/types';
import useFetchWalletData from '../hooks/useFetchWalletData';
import UTXOService from '../services/UTXOService';

type AssetTab = 'BCH' | 'Tokens' | 'NFTs';
const isDev = import.meta.env.DEV;

function formatTokenAmount(amount: bigint, decimals: number): string {
  if (decimals <= 0) return amount.toString();
  const normalizedDecimals = Math.max(0, Math.trunc(decimals));
  const divisor = 10n ** BigInt(normalizedDecimals);
  const whole = amount / divisor;
  const fraction = amount % divisor;
  if (fraction === 0n) return whole.toString();
  const fractionText = fraction
    .toString()
    .padStart(normalizedDecimals, '0')
    .replace(/0+$/, '');
  return fractionText ? `${whole.toString()}.${fractionText}` : whole.toString();
}

const Assets: React.FC = () => {
  const navigate = useNavigate();
  const [tab, setTab] = useState<AssetTab>('BCH');
  const [selectedTokenCategory, setSelectedTokenCategory] = useState<string | null>(null);
  const [quantumrootBalance, setQuantumrootBalance] = useState(0);
  const [quantumrootVaultCount, setQuantumrootVaultCount] = useState(0);
  const currentWalletId = useSelector((state: RootState) => state.wallet_id.currentWalletId);
  const totalBalance = useSelector((state: RootState) => state.utxos.totalBalance);
  const fetchingUTXOs = useSelector((state: RootState) => state.utxos.fetchingUTXOs);
  const currentNetwork = useSelector((state: RootState) => state.network.currentNetwork);
  const [walletAddresses, setWalletAddresses] = useState<
    { address: string; tokenAddress: string }[]
  >([]);
  const [, setWalletContractAddresses] = useState<unknown[]>([]);
  const [, setWalletContractUtxos] = useState<UTXO[]>([]);
  const [, setDefaultChangeAddress] = useState<string>('');
  const [, setWalletError] = useState<string | null>(null);
  const [tokenUtxos, setTokenUtxos] = useState<UTXO[]>([]);
  const noopSetUtxos = useCallback(() => undefined, []);

  const refreshQuantumrootPortfolio = useCallback(async () => {
    if (!currentWalletId) {
      setQuantumrootBalance(0);
      setQuantumrootVaultCount(0);
      return;
    }

    try {
      const summary = await QuantumrootPortfolioService.summarizeWallet(currentWalletId);
      setQuantumrootBalance(summary.quantumrootBalanceSats);
      setQuantumrootVaultCount(summary.vaultCount);
    } catch (error) {
      logError('Assets.refreshQuantumrootPortfolio', error, { walletId: currentWalletId });
    }
  }, [currentWalletId]);

  useEffect(() => {
    void refreshQuantumrootPortfolio();
  }, [refreshQuantumrootPortfolio]);

  useFetchWalletData(
    currentWalletId,
    setWalletAddresses,
    setWalletContractAddresses,
    noopSetUtxos,
    setWalletContractUtxos,
    setDefaultChangeAddress,
    setWalletError
  );

  useEffect(() => {
    let cancelled = false;

    async function loadNativeTokenInventory(): Promise<void> {
      if (!currentWalletId || walletAddresses.length === 0) {
        if (!cancelled) {
          setTokenUtxos([]);
        }
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

        const deduped = new Map<string, UTXO>();
        for (const utxo of nextTokenUtxos) {
          const category = utxo.token?.category;
          if (!category) continue;
          deduped.set(`${utxo.tx_hash}:${utxo.tx_pos}`, utxo);
        }
        setTokenUtxos(Array.from(deduped.values()));

        if (isDev) {
          console.log('[Assets] grouped token rows', {
            walletId: currentWalletId,
            groupedCount: deduped.size,
            groupedCategories: Array.from(deduped.values()).map(
              (utxo) => utxo.token?.category
            ),
          });
        }
      } catch (error) {
        logError('Assets.loadNativeTokenInventory', error, { walletId: currentWalletId });
        if (!cancelled) setTokenUtxos([]);
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
  const fungibleTokens = entries.filter(([, value]) => value.amount > 0n);
  const nftTokens = entries.filter(([, value]) => value.nft);
  const tokenMetadata = useSharedTokenMetadata(entries.map(([category]) => category));
  const selectedTokenMetadata = selectedTokenCategory
    ? tokenMetadata[selectedTokenCategory]
    : null;
  const formatTokenDecimalsLabel = useCallback((decimals: number) => {
    const normalizedDecimals = Math.max(0, Math.trunc(decimals));
    return normalizedDecimals === 1
      ? '1 decimal'
      : `${normalizedDecimals} decimals`;
  }, []);

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
      categories: entries.map(([category]) => category),
    });
  }, [currentWalletId, tab, walletAddresses.length, tokenUtxos.length, entries, fungibleTokens.length, nftTokens.length]);

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
                    <div className="text-2xl font-bold wallet-text-strong">
                      {(totalBalance / SATSINBITCOIN).toFixed(8)} BCH
                    </div>
                    <div className="text-xs wallet-muted">
                      {fetchingUTXOs ? 'Refreshing balances…' : `${totalBalance.toLocaleString()} sats`}
                    </div>
                  </div>
                  <div className="flex h-14 w-14 items-center justify-center rounded-3xl bg-[color-mix(in_oklab,var(--wallet-accent-soft)_72%,transparent)] text-[var(--wallet-accent-strong)]">
                    <FaBitcoin className="text-2xl" />
                  </div>
                </div>
              </SectionCard>
              <div className="grid grid-cols-2 gap-2.5">
                <button className="wallet-btn-primary py-2.5" onClick={() => navigate('/receive')}>
                  Receive
                </button>
                <button className="wallet-btn-secondary py-2.5" onClick={() => navigate('/send')}>
                  Send
                </button>
              </div>
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
                      const decimals = value.decimals;
                      const displayAmount = formatTokenAmount(value.amount, decimals);
                      return (
                        <button
                          key={category}
                          type="button"
                          className="wallet-card w-full p-2.5 text-left transition hover:brightness-[0.98]"
                          onClick={() => setSelectedTokenCategory(category)}
                        >
                          <div className="flex items-center gap-2.5">
                            <TokenAvatar
                              iconUri={metadata?.status === 'ready' ? metadata.iconUri : null}
                              name={metadata?.status === 'ready' && metadata.name ? metadata.name : shortenTxHash(category)}
                              sizeClassName="h-9 w-9"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-semibold wallet-text-strong">
                                {metadata?.status === 'ready' && metadata.name ? metadata.name : shortenTxHash(category)}
                              </div>
                              <div className="truncate text-xs wallet-muted">
                                {metadata?.status === 'ready' && metadata.symbol
                                  ? `${metadata.symbol}${decimals > 0 ? ` • ${formatTokenDecimalsLabel(decimals)}` : ''}`
                                  : `${shortenTxHash(category)}${decimals > 0 ? ` • ${formatTokenDecimalsLabel(decimals)}` : ''}`}
                              </div>
                            </div>
                            <div className="shrink-0 text-right">
                              <div className="text-sm font-semibold wallet-text-strong">
                                {displayAmount}
                              </div>
                              <div className="text-xs wallet-muted">
                                {value.amount.toString()} units
                              </div>
                            </div>
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
                Mint Tokens
              </button>
            </div>
          )}

          {tab === 'NFTs' && (
            <div className="flex h-full min-h-0 flex-col gap-2.5">
              <SectionCard className="min-h-0 flex-1 overflow-hidden p-3">
                <SectionHeader title="NFTs" subtitle="Non-fungible holdings" compact />
                <div className="h-full min-h-0 space-y-2.5 overflow-y-auto overscroll-contain pb-[calc(var(--safe-bottom)+1rem)] pr-1">
                  {nftTokens.length > 0 ? (
                    nftTokens.map(([category, value]) => {
                      const metadata = tokenMetadata[category];
                      return (
                        <button
                          key={category}
                          type="button"
                          className="wallet-card w-full p-2.5 text-left transition hover:brightness-[0.98]"
                          onClick={() => setSelectedTokenCategory(category)}
                        >
                          <div className="flex items-center gap-2.5">
                            <TokenAvatar
                              iconUri={metadata?.status === 'ready' ? metadata.iconUri : null}
                              name={metadata?.status === 'ready' && metadata.name ? metadata.name : shortenTxHash(category)}
                              sizeClassName="h-9 w-9"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-semibold wallet-text-strong">
                                {metadata?.status === 'ready' && metadata.name ? metadata.name : shortenTxHash(category)}
                              </div>
                              <div className="truncate text-xs wallet-muted">
                                {metadata?.status === 'ready' && metadata.symbol
                                  ? metadata.symbol
                                  : 'NFT'}
                              </div>
                            </div>
                            <div className="shrink-0 text-right">
                              <div className="text-sm font-semibold wallet-text-strong">
                                {value.amount.toString()}
                              </div>
                              <div className="text-xs wallet-muted">collectibles</div>
                            </div>
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
                Mint Tokens
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
                  {quantumrootVaultCount > 0
                    ? `${quantumrootVaultCount} vault${quantumrootVaultCount === 1 ? '' : 's'} tracked`
                    : 'No vaults tracked yet'}
                </div>
                <div className="text-xs wallet-muted">
                  {quantumrootBalance > 0
                    ? `${(quantumrootBalance / SATSINBITCOIN).toFixed(8)} BCH`
                    : 'Receive and recovery tools for advanced vaults'}
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
              prefetchedSnapshot={
                selectedTokenMetadata?.status === 'ready'
                  ? (selectedTokenMetadata.snapshot as IdentitySnapshot)
                  : null
              }
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
