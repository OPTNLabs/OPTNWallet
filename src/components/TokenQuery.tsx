//@ts-nocheck
import React, { useEffect, useState } from 'react';
import {
  queryTotalSupplyFT,
  queryActiveMinting,
  querySupplyNFTs,
  queryAuthHead,
} from '../apis/ChaingraphManager/ChaingraphManager';
import { shortenTxHash } from '../utils/shortenHash';

interface TokenQueryProps {
  tokenId: string;
}

const TokenQuery: React.FC<TokenQueryProps> = ({ tokenId }) => {
  const [totalSupply, setTotalSupply] = useState<number | null>(null);
  const [activeMinting, setActiveMinting] = useState<boolean | null>(null);
  const [nftSupply, setNftSupply] = useState<number | null>(null);
  const [authHead, setAuthHead] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      setError(null);

      try {
        // console.log('Fetching total supply for tokenId:', tokenId);
        // Query total supply of fungible tokens
        const totalSupplyData = await queryTotalSupplyFT(tokenId);
        // console.log('Total supply data:', totalSupplyData);

        const totalSupply =
          totalSupplyData?.data?.transaction?.[0]?.outputs?.reduce(
            (total: number, output: any) =>
              total + parseInt(output.fungible_token_amount, 10),
            0
          ) ?? 0;
        setTotalSupply(totalSupply);

        // console.log('Fetching active minting status for tokenId:', tokenId);
        // Query active minting status
        const activeMintingData = await queryActiveMinting(tokenId);
        // console.log('Active minting data:', activeMintingData);
        const isActiveMinting = activeMintingData?.data?.output?.length > 0;
        setActiveMinting(isActiveMinting);

        // console.log('Fetching NFT supply for tokenId:', tokenId);
        // Query NFT supply
        const nftSupplyData = await querySupplyNFTs(tokenId);
        // console.log('NFT supply data:', nftSupplyData);
        const totalNftSupply = nftSupplyData?.data?.output?.length ?? 0;
        setNftSupply(totalNftSupply);

        // console.log('Fetching AuthHead for tokenId:', tokenId);
        // Query AuthHead details
        const authHeadData = await queryAuthHead(tokenId);
        // console.log('AuthHead data:', authHeadData);
        const authHeadTransaction =
          authHeadData?.data?.transaction?.[0]?.authchains?.[0]?.authhead
            ?.identity_output?.[0]?.transaction_hash ?? null;
        setAuthHead(authHeadTransaction);
      } catch (err) {
        console.error('Error fetching token data:', err);
        setError('Failed to fetch token data.');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [tokenId]);

  if (loading) return <p>Loading token data...</p>;
  if (error) return <p>{error}</p>;

  return (
    <div className="token-query">
      <h3>Token ID: {shortenTxHash(tokenId)}</h3>
      <p>Total Supply: {totalSupply}</p>
      <p>Active Minting: {activeMinting ? 'Yes' : 'No'}</p>
      <p>Total NFTs: {nftSupply}</p>
      {/* <p>Auth Head: {authHead}</p> */}
    </div>
  );
};

export default TokenQuery;
