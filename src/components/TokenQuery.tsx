import React, { useEffect, useState } from 'react';
import {
  queryTotalSupplyFT,
  queryActiveMinting,
  querySupplyNFTs,
  queryAuthHead,
} from '../apis/ChaingraphManager/ChaingraphManager';
import { shortenTxHash } from '../utils/shortenHash';
import BcmrService, { IdentityRegistry } from '../services/BcmrService';
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
  const [registry, setRegistry] = useState<IdentityRegistry | null>(null);
  const [snapshot, setSnapshot] = useState<IdentitySnapshot | null>(null);
  const [iconDataUri, setIconDataUri] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      setError(null);

      try {
        // 1) Total supply
        const totalData = await queryTotalSupplyFT(tokenId);
        const total =
          totalData?.data?.transaction?.[0]?.outputs?.reduce(
            (sum: number, o: any) =>
              sum + parseInt(o.fungible_token_amount, 10),
            0
          ) ?? 0;
        setTotalSupply(total);

        // 2) Active minting
        const mintData = await queryActiveMinting(tokenId);
        setActiveMinting(mintData?.data?.output?.length > 0);

        // 3) NFT supply
        const nftData = await querySupplyNFTs(tokenId);
        setNftSupply(nftData?.data?.output?.length ?? 0);

        // 4) Auth head
        const ahData = await queryAuthHead(tokenId);
        const ahRaw =
          ahData?.data?.transaction?.[0]?.authchains?.[0]?.authhead
            ?.identity_output?.[0]?.transaction_hash;
        const ahTx = ahRaw ? latin1ToHex(ahRaw) : null;
        setAuthHead(ahTx);

        // 5) BCMR lookup
        const bcmr = new BcmrService();
        const authbase = await bcmr.getCategoryAuthbase(tokenId);
        const idReg = await bcmr.resolveIdentityRegistry(authbase);
        setRegistry(idReg);
        console.log(registry);

        // 6) Snapshot
        const snap = bcmr.extractIdentity(authbase, idReg.registry);
        console.log(snap);
        setSnapshot(snap);

        // 7) Icon
        const dataUri = await bcmr.resolveIcon(authbase);
        setIconDataUri(dataUri);
      } catch (err: any) {
        console.error('Error fetching token data:', err);
        setError(err.message || 'Failed to fetch token data.');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [tokenId]);

  if (loading) return <p>Loading token data…</p>;
  if (error) return <p className="text-red-600">{error}</p>;

  return (
    <div className="token-query space-y-4">
      <h3 className="font-semibold">Token ID: {shortenTxHash(tokenId)}</h3>
      <p>Total Supply: {totalSupply}</p>
      <p>Active Minting: {activeMinting ? 'Yes' : 'No'}</p>
      <p>Total NFTs: {nftSupply}</p>
      <p>Auth Head: {shortenTxHash(authHead || '')}</p>

      {snapshot && (
        <div className="bcmr-meta p-4 border rounded-lg">
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
                className="text-blue-600 underline"
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
