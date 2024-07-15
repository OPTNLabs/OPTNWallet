// src/components/RecoveryPhrase.tsx

import React, { useState, useEffect } from 'react';
import WalletManager from '../apis/WalletManager/WalletManager';

const RecoveryPhrase = () => {
  const [mnemonic, setMnemonic] = useState('');

  useEffect(() => {
    const fetchMnemonic = async () => {
      const walletManager = WalletManager();
      const walletId = await walletManager.walletExists(); // Replace this with actual logic to fetch the current wallet ID
      if (walletId) {
        const walletInfo = await walletManager.getWalletInfo(walletId);
        if (walletInfo) {
          setMnemonic(walletInfo.mnemonic);
        }
      }
    };
    fetchMnemonic();
  }, []);

  return (
    <div>
      <h2 className="text-xl font-bold mb-2">Recovery Phrase</h2>
      <p className="border p-4 rounded-lg bg-gray-100">{mnemonic}</p>
    </div>
  );
};

export default RecoveryPhrase;
