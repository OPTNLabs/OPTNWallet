import React, { useEffect, useMemo, useState } from 'react';
import {
  queryTotalSupplyFT,
  queryActiveMinting,
  querySupplyNFTs,
  queryAuthHead,
  stripChaingraphHexBytes,
} from '../apis/ChaingraphManager/ChaingraphManager';
import { shortenTxHash } from '../utils/shortenHash';
import useSharedTokenMetadata from '../hooks/useSharedTokenMetadata';
import { normalizeExternalUrl } from '../utils/externalUrl';
import TokenIdentityBadge from './ui/TokenIdentityBadge';
import { resolveTokenPresentation } from '../utils/tokenPresentation';
import {
  type BcmrSnapshot,
} from '../types/bcmr';

interface TokenQueryProps {
  tokenId: string;
  prefetchedSnapshot?: BcmrSnapshot | null;
  prefetchedIconDataUri?: string | null;
}

const TokenQuery: React.FC<TokenQueryProps> = ({
  tokenId,
  prefetchedSnapshot = null,
  prefetchedIconDataUri = null,
}) => {
  const [totalSupply, setTotalSupply] = useState<number | null>(null);
  const [activeMinting, setActiveMinting] = useState<boolean | null>(null);
  const [nftSupply, setNftSupply] = useState<number | null>(null);
  const [authHead, setAuthHead] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<BcmrSnapshot | null>(prefetchedSnapshot);
  const [iconDataUri, setIconDataUri] = useState<string | null>(
    prefetchedIconDataUri
  );
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [bcmrError, setBcmrError] = useState<string | null>(null);
  const tokenCategories = useMemo(() => [tokenId], [tokenId]);
  const sharedTokenMetadata = useSharedTokenMetadata(tokenCategories)[tokenId];
  const displaySnapshot: BcmrSnapshot | null =
    sharedTokenMetadata?.snapshot ?? prefetchedSnapshot ?? null;
  const displayIconDataUri =
    sharedTokenMetadata?.iconUri ?? prefetchedIconDataUri ?? null;
  const displayTokenMetadata = displaySnapshot
    ? {
        ...(sharedTokenMetadata ?? {
          status: 'ready' as const,
          freshness: 'cached' as const,
          name: displaySnapshot.name || tokenId,
          symbol: displaySnapshot.token?.symbol || '',
          decimals: displaySnapshot.token?.decimals ?? 0,
          iconUri: displayIconDataUri,
          snapshot: displaySnapshot,
          isRefreshing: false,
          lastFetch: displaySnapshot.lastFetch ?? null,
          registryUri: displaySnapshot.registryUri ?? null,
          registryHash: displaySnapshot.registryHash ?? null,
        }),
        status:
          sharedTokenMetadata?.status === 'loading'
            ? ('ready' as const)
            : sharedTokenMetadata?.status ?? ('ready' as const),
        freshness:
          sharedTokenMetadata?.snapshot
            ? sharedTokenMetadata.freshness
            : sharedTokenMetadata?.status === 'loading'
              ? ('refreshing' as const)
              : sharedTokenMetadata?.status === 'error'
                ? ('cached' as const)
                : (sharedTokenMetadata?.freshness ?? ('cached' as const)),
        name: displaySnapshot.name || tokenId,
        symbol: displaySnapshot.token?.symbol || '',
        decimals: displaySnapshot.token?.decimals ?? 0,
        iconUri: displayIconDataUri,
        snapshot: displaySnapshot,
        error: sharedTokenMetadata?.error,
        lastFetch: sharedTokenMetadata?.lastFetch ?? displaySnapshot.lastFetch ?? null,
        registryUri:
          sharedTokenMetadata?.registryUri ?? displaySnapshot.registryUri ?? null,
        registryHash:
          sharedTokenMetadata?.registryHash ?? displaySnapshot.registryHash ?? null,
        isRefreshing:
          sharedTokenMetadata?.isRefreshing ||
          sharedTokenMetadata?.status === 'loading' ||
          false,
      }
      : sharedTokenMetadata;
  const presentation = resolveTokenPresentation(tokenId, displayTokenMetadata, {
    name: displaySnapshot?.name ?? null,
    symbol: displaySnapshot?.token?.symbol ?? null,
    decimals: displaySnapshot?.token?.decimals ?? null,
    iconUri: displayIconDataUri ?? null,
  });
  const officialSiteUrl = snapshot?.uris?.web
    ? normalizeExternalUrl(snapshot.uris.web)
    : null;

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      setError(null);
      setBcmrError(null);
      setSnapshot(displaySnapshot);
      setIconDataUri(displayIconDataUri);

      let failedCoreQueries = 0;

      try {
        // 1) Total supply (non-fatal if this specific query fails)
        const totalData = await queryTotalSupplyFT(tokenId);
        const total =
          totalData?.data?.transaction?.[0]?.outputs?.reduce(
            (sum: number, o: { fungible_token_amount?: string | number }) =>
              sum + parseInt(String(o.fungible_token_amount ?? 0), 10),
            0
          ) ?? 0;
        setTotalSupply(total);
      } catch {
        failedCoreQueries += 1;
      }

      try {
        // 2) Active minting (non-fatal if this specific query fails)
        const mintData = await queryActiveMinting(tokenId);
        const mintOutputs = mintData?.data?.output;
        setActiveMinting(Array.isArray(mintOutputs) && mintOutputs.length > 0);
      } catch {
        failedCoreQueries += 1;
      }

      try {
        // 3) NFT supply (non-fatal if this specific query fails)
        const nftData = await querySupplyNFTs(tokenId);
        const nftOutputs = nftData?.data?.output;
        setNftSupply(Array.isArray(nftOutputs) ? nftOutputs.length : 0);
      } catch {
        failedCoreQueries += 1;
      }

      try {
        // 4) Auth head (non-fatal if this specific query fails)
        const ahData = await queryAuthHead(tokenId);
        const ahRaw =
          ahData?.data?.transaction?.[0]?.authchains?.[0]?.authhead
            ?.identity_output?.[0]?.transaction_hash;
        const ahTx = stripChaingraphHexBytes(ahRaw) || null;
        setAuthHead(ahTx);
      } catch {
        failedCoreQueries += 1;
      }

      try {
        if (!displaySnapshot && (!sharedTokenMetadata || sharedTokenMetadata.status === 'loading')) {
          // Shared metadata is still loading; avoid flashing an error state.
        } else if (!displaySnapshot && sharedTokenMetadata?.status === 'error') {
          throw new Error(sharedTokenMetadata.error || 'Failed to fetch BCMR metadata.');
        } else if (!displaySnapshot) {
          throw new Error('Failed to fetch token data.');
        }
      } catch (err: unknown) {
        if (!displaySnapshot) {
          setBcmrError(
            err instanceof Error ? err.message : 'Failed to fetch token data.'
          );
        }
      }

      if (failedCoreQueries >= 4) {
        setError('Unable to load token chain statistics right now.');
      }

      setLoading(false);
    };

    fetchData();
  }, [
    tokenId,
    prefetchedSnapshot,
    prefetchedIconDataUri,
    sharedTokenMetadata,
    displaySnapshot,
    displayIconDataUri,
  ]);

  if (loading && !snapshot) return <p className="wallet-muted">Loading token data…</p>;

  return (
    <div className="token-query space-y-4">
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-semibold wallet-text-strong">
            Token ID: {shortenTxHash(tokenId)}
          </h3>
        </div>
        <TokenIdentityBadge
          presentation={presentation}
          className="rounded-2xl border border-[var(--wallet-border)] bg-[var(--wallet-surface-strong)] p-3"
          avatarClassName="h-10 w-10"
        />
      </div>
      {error && <p className="wallet-danger-text">{error}</p>}
      <p>Total Supply: {totalSupply ?? 'Unavailable'}</p>
      <p>Active Minting: {activeMinting === null ? 'Unavailable' : activeMinting ? 'Yes' : 'No'}</p>
      <p>Total NFTs: {nftSupply ?? 'Unavailable'}</p>
      <p>Auth Head: {authHead ? shortenTxHash(authHead) : 'Unavailable'}</p>
      {loading && <p className="wallet-muted">Loading token data…</p>}
      {bcmrError && (
        <p className="wallet-danger-text">
          BCMR metadata unavailable: {bcmrError}
        </p>
      )}
      {presentation.statusLabel ? (
        <p className="text-xs font-medium wallet-muted">
          BCMR: {presentation.statusLabel}
        </p>
      ) : null}

      {snapshot && (
        <div className="bcmr-meta p-4 border rounded-lg wallet-card max-h-64 overflow-y-auto">
          {(iconDataUri || snapshot.uris?.icon) && (
            <img
              src={iconDataUri || snapshot.uris!.icon!}
              alt={`${snapshot.name} icon`}
              className="w-16 h-16 rounded mb-2"
            />
          )}
          <h4 className="text-lg font-semibold">{snapshot.name}</h4>
          {snapshot.description && <p>{snapshot.description}</p>}
          <div className="mt-2 space-y-1 text-sm wallet-muted break-all">
            <p>Category: {snapshot.token?.category || tokenId}</p>
            {snapshot.token?.symbol && <p>Symbol: {snapshot.token.symbol}</p>}
            {typeof snapshot.token?.decimals === 'number' && (
              <p>Decimals: {snapshot.token.decimals}</p>
            )}
          </div>
          {officialSiteUrl && (
            <p className="mt-2">
              <a
                href={officialSiteUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="wallet-link underline"
              >
                Official Site
              </a>
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default TokenQuery;
