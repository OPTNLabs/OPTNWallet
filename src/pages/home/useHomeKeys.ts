import { useCallback, useEffect, useState } from 'react';
import KeyService from '../../services/KeyService';
import { logError } from '../../utils/errorHandling';

const BATCH_AMOUNT = 10;

export type WalletKey = { address: string; addressIndex: number };

type UseHomeKeysParams = {
  currentWalletId: number | null;
};

export function useHomeKeys({ currentWalletId }: UseHomeKeysParams) {
  const [keyPairs, setKeyPairs] = useState<WalletKey[]>([]);
  const [generatingKeys, setGeneratingKeys] = useState(false);

  const handleGenerateKeys = useCallback(
    async (index: number) => {
      if (!currentWalletId) return null;

      try {
        const before = await KeyService.retrieveKeys(currentWalletId);
        const beforeSet = new Set(before.map((k) => k.address));

        for (let i = 0; i < 2; i++) {
          await KeyService.createKeys(currentWalletId, 0, i, index);
        }

        const after = await KeyService.retrieveKeys(currentWalletId);
        const newKeys = after.filter((k) => !beforeSet.has(k.address));
        if (newKeys.length > 0) {
          setKeyPairs((prevKeys) => [...prevKeys, ...newKeys]);
        }
      } catch (error) {
        logError('Home.handleGenerateKeys', error, {
          walletId: currentWalletId,
          index,
        });
      }
      return null;
    },
    [currentWalletId]
  );

  const generateKeys = useCallback(async () => {
    if (!currentWalletId || generatingKeys) return;

    setGeneratingKeys(true);
    const existingKeys = await KeyService.retrieveKeys(currentWalletId);

    if (existingKeys.length === 0) {
      for (let i = 0; i < BATCH_AMOUNT; i++) {
        await handleGenerateKeys(i);
      }
    } else {
      setKeyPairs(existingKeys);
    }

    setGeneratingKeys(false);
  }, [currentWalletId, generatingKeys, handleGenerateKeys]);

  useEffect(() => {
    if (!currentWalletId) return;

    const loadKeys = async () => {
      const existingKeys = await KeyService.retrieveKeys(currentWalletId);
      setKeyPairs(existingKeys);
      if (existingKeys.length === 0) {
        await generateKeys();
      }
    };
    void loadKeys();
  }, [currentWalletId, generateKeys]);

  return {
    keyPairs,
    generatingKeys,
    handleGenerateKeys,
  };
}
