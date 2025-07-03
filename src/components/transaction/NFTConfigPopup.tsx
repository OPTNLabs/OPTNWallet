import React from 'react';
import Popup from './Popup';

interface NFTConfigPopupProps {
  show: boolean;
  setShow: (value: boolean) => void;
  nftCapability: 'none' | 'mutable' | 'minting';
  setNftCapability: (value: 'none' | 'mutable' | 'minting') => void;
  nftCommitment: string;
  setNftCommitment: (value: string) => void;
}

const NFTConfigPopup: React.FC<NFTConfigPopupProps> = ({
  show,
  setShow,
  nftCapability,
  setNftCapability,
  nftCommitment,
  setNftCommitment,
}) => {
  if (!show) return null;
  return (
    <Popup closePopups={() => setShow(false)}>
      <div className="p-4">
        <h3 className="text-lg font-semibold mb-2">NFT Configuration</h3>
        <div className="mb-2">
          <label className="block font-medium mb-1">NFT Capability</label>
          <select
            value={nftCapability}
            onChange={(e) => setNftCapability(e.target.value as 'none' | 'mutable' | 'minting')}
            className="border p-2 w-full"
          >
            <option value="none">none</option>
            <option value="mutable">mutable</option>
            <option value="minting">minting</option>
          </select>
        </div>
        <div className="mb-2">
          <label className="block font-medium mb-1">NFT Commitment</label>
          <input
            type="text"
            value={nftCommitment}
            onChange={(e) => setNftCommitment(e.target.value)}
            placeholder="Up to 40 bytes"
            className="border p-2 w-full break-words whitespace-normal"
          />
        </div>
        <button
          onClick={() => setShow(false)}
          className="bg-blue-500 text-white font-bold py-1 px-3 rounded"
        >
          Done
        </button>
      </div>
    </Popup>
  );
};

export default NFTConfigPopup;