// @ts-nocheck
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

  const words = mnemonic.split(' ');

  return (
    <div className="flex justify-center">
      <div className="text-center">
        <div className="border p-4 rounded-lg bg-gray-100 grid grid-cols-2 gap-x-4 justify-center">
          {words.map((word, index) => (
            <div key={index} className="text-left">
              {index + 1}. {word}
            </div>
          ))}
        </div>
        <div className="flex justify-center mt-4">
          <img
            src="/assets/images/OPTNWelcome3.png"
            alt="Welcome"
            className="max-w-full h-auto"
          />
        </div>
      </div>
    </div>
  );
};

export default RecoveryPhrase;
