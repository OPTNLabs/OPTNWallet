import { useState, useEffect } from 'react';
import WalletManager from '../apis/WalletManager/WalletManager';

const RecoveryPhrase = () => {
  const [mnemonic, setMnemonic] = useState('');
  const [isRevealed, setIsRevealed] = useState<boolean>(false);

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

  const handleReveal = () => {
    setIsRevealed(true);
  };

  const handleHide = () => {
    setIsRevealed(false);
  };

  const words = mnemonic.split(' ');

  return (
    <div className="flex justify-center h-4/5 mb-4">
      <div className="text-center mt-10">
        {!isRevealed ? (
          <>
            <div className="flex justify-center items-base line mt-4">
              <img
                src="/assets/images/OPTNWelcome3.png"
                alt="Welcome"
                className="max-w-full h-auto"
                width={'68%'}
                height={'68%'}
              />
            </div>
            <button
              onClick={handleReveal}
              className="wallet-btn-danger"
            >
              Reveal Backup Phrase
            </button>
          </>
        ) : (
          <>
            <div className="wallet-card p-4 grid grid-cols-2 gap-y-2">
              {words.map((word, index) => (
                <div key={index} className="text-center">
                  {index + 1}. {word}
                </div>
              ))}
            </div>
            {/* Optional: Hide button */}
            <button
              onClick={handleHide}
              className="wallet-btn-primary mt-4"
            >
              Hide Backup Phrase
            </button>
          </>
        )}
        <div className="my-4 text-center">
          <p className="font-bold underline text-xl wallet-danger-text">Warning</p>
          <p className="justify-center text-sm my-2 p-1 wallet-muted">
            Displaying your mnemonic backup phrase can compromise your funds.
            Ensure you keep it secure.
          </p>
        </div>
      </div>
    </div>
  );
};

export default RecoveryPhrase;
