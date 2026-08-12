import React from 'react';
import Popup from './Popup';
import type { TokenCapability } from '../../../services/cashtokens';

interface NFTConfigPopupProps {
  show: boolean;
  setShow: (value: boolean) => void;
  nftCapability: undefined | TokenCapability;
  setNftCapability: (value: undefined | TokenCapability) => void;
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
            onChange={(e) =>
              setNftCapability(e.target.value as undefined | TokenCapability)
            }
            className="wallet-input p-2 w-full"
          >
            <option value="none">none</option>
            <option value="mutable">mutable</option>
            <option value="minting">minting</option>
          </select>
          <div className="mt-2 text-xs wallet-muted space-y-1">
            <p><strong>none</strong>: one immutable NFT, best for approvals or receipts.</p>
            <p><strong>mutable</strong>: one NFT that may update its commitment when spent.</p>
            <p><strong>minting</strong>: one NFT authority that can create multiple next NFTs.</p>
          </div>
        </div>
        <div className="mb-2">
          <label className="block font-medium mb-1">NFT Commitment</label>
          <input
            type="text"
            value={nftCommitment}
            onChange={(e) => setNftCommitment(e.target.value)}
            placeholder="Up to 40 bytes"
            className="wallet-input p-2 w-full break-words whitespace-normal"
          />
        </div>
        <button
          onClick={() => setShow(false)}
          className="wallet-btn-primary font-bold py-1 px-3"
        >
          Done
        </button>
      </div>
    </Popup>
  );
};

export default NFTConfigPopup;
