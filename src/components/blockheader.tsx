import React, { useState, useEffect } from 'react';
import ElectrumService from '../services/ElectrumService';

interface BlockHeader {
  height: number;
  hex: string;
}

const BlockHeaderDisplay: React.FC = () => {
  const [blockHeader, setBlockHeader] = useState<BlockHeader | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Initial fetch of latest block
    const fetchInitialBlock = async () => {
      try {
        const block = await ElectrumService.getLatestBlock();
        if (block) {
          setBlockHeader(block as BlockHeader);
        }
      } catch (err) {
        setError('Failed to fetch initial block header');
      }
    };

    // Subscribe to block header updates
    const handleBlockUpdate = (header: BlockHeader) => {
      setBlockHeader(header);
      setError(null);
    };

    fetchInitialBlock();
    ElectrumService.subscribeBlockHeaders(handleBlockUpdate);

    // Cleanup subscription on component unmount
    return () => {
      // Note: You might need to implement an unsubscribe method in your ElectrumServer
    };
  }, []);

  if (error) {
    return <div>Error: {error}</div>;
  }

  if (!blockHeader) {
    return <div>Loading block header...</div>;
  }

  return (
    <div>
      <h2>Latest Block Header</h2>
      <p>Height: {blockHeader.height}</p>
      <p>Header Hash: {blockHeader.hex}</p>
    </div>
  );
};

export default BlockHeaderDisplay;
