import React, { useEffect, useState } from 'react';
import {
  queryTotalSupplyFT,
  queryActiveMinting,
  querySupplyNFTs,
  queryAuthHead,
} from '../apis/ChaingraphManager/ChaingraphManager';
import { shortenTxHash } from '../utils/shortenHash';
import BcmrService from '../services/BcmrService';
import { IdentitySnapshot } from '@bitauth/libauth';
import { latin1ToHex } from '../utils/hex';

interface TokenQueryProps {
  tokenId: string;
}

const TokenQuery: React.FC<TokenQueryProps> = ({ tokenId }) => {
  const [totalSupply, setTotalSupply] = useState<number | null>(null);
  const [activeMinting, setActiveMinting] = useState<boolean | null>(null);
  const [nftSupply, setNftSupply] = useState<number | null>(null);
  const [authHead, setAuthHead] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<IdentitySnapshot | null>(null);
  const [iconDataUri, setIconDataUri] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [bcmrError, setBcmrError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      setError(null);
      setBcmrError(null);

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
        const ahTx = ahRaw ? latin1ToHex(ahRaw) : null;
        setAuthHead(ahTx);
      } catch {
        failedCoreQueries += 1;
      }

      try {
        // 5) BCMR lookup
        const bcmr = new BcmrService();
        const authbase = await bcmr.getCategoryAuthbase(tokenId);
        const idReg = await bcmr.resolveIdentityRegistry(authbase);

        // 6) Snapshot
        const snap = bcmr.extractIdentity(authbase, idReg.registry);
        setSnapshot(snap);

        // 7) Icon
        const dataUri = await bcmr.resolveIcon(authbase);
        setIconDataUri(dataUri);
      } catch (err: unknown) {
        setBcmrError(
          err instanceof Error ? err.message : 'Failed to fetch token data.'
        );
        setSnapshot(null);
        setIconDataUri(null);
      }

      if (failedCoreQueries >= 4) {
        setError('Unable to load token chain statistics right now.');
      }

      setLoading(false);
    };

    fetchData();
  }, [tokenId]);

  if (loading) return <p className="wallet-muted">Loading token data…</p>;

  return (
    <div className="token-query space-y-4">
      <h3 className="font-semibold wallet-text-strong">Token ID: {shortenTxHash(tokenId)}</h3>
      {error && <p className="wallet-danger-text">{error}</p>}
      <p>Total Supply: {totalSupply ?? 'Unavailable'}</p>
      <p>Active Minting: {activeMinting === null ? 'Unavailable' : activeMinting ? 'Yes' : 'No'}</p>
      <p>Total NFTs: {nftSupply ?? 'Unavailable'}</p>
      <p>Auth Head: {authHead ? shortenTxHash(authHead) : 'Unavailable'}</p>
      {bcmrError && (
        <p className="wallet-danger-text">
          BCMR metadata unavailable: {bcmrError}
        </p>
      )}

      {snapshot && (
        <div className="bcmr-meta p-4 border rounded-lg wallet-card">
          {(iconDataUri || snapshot.uris?.icon) && (
            <img
              src={iconDataUri || snapshot.uris!.icon!}
              alt={`${snapshot.name} icon`}
              className="w-16 h-16 rounded mb-2"
            />
          )}
          <h4 className="text-lg font-semibold">{snapshot.name}</h4>
          {snapshot.description && <p>{snapshot.description}</p>}
          {snapshot.uris?.web && (
            <p className="mt-2">
              <a
                href={snapshot.uris.web}
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
