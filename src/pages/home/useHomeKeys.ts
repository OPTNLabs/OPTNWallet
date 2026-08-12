import { useCallback, useEffect, useRef, useState } from 'react';
import KeyService from '../../services/KeyService';
import { logError } from '../../utils/errorHandling';

export type WalletKey = { address: string; addressIndex: number };

type UseHomeKeysParams = {
  currentWalletId: number | null;
};

export function useHomeKeys({ currentWalletId }: UseHomeKeysParams) {
  const [keyPairs, setKeyPairs] = useState<WalletKey[]>([]);
  const [generatingKeys, setGeneratingKeys] = useState(false);
  const batchGenerationRef = useRef(false);
  const inflightIndexesRef = useRef<Set<number>>(new Set());

  const handleGenerateKeys = useCallback(
    async (index: number) => {
      if (!currentWalletId || inflightIndexesRef.current.has(index)) return null;

      inflightIndexesRef.current.add(index);
      batchGenerationRef.current = true;
      setGeneratingKeys(true);

      try {
        const before = await KeyService.retrieveKeys(currentWalletId);
        const beforeSet = new Set(before.map((k) => k.address));

        for (let i = 0; i < 2; i += 1) {
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
      } finally {
        inflightIndexesRef.current.delete(index);
        batchGenerationRef.current = false;
        setGeneratingKeys(false);
      }
      return null;
    },
    [currentWalletId]
  );

  useEffect(() => {
    if (!currentWalletId) return;

    const loadKeys = async () => {
      setGeneratingKeys(true);
      try {
        const existingKeys = await KeyService.retrieveKeys(currentWalletId);
        setKeyPairs(existingKeys);
      } catch (error) {
        logError('Home.loadKeys', error, {
          walletId: currentWalletId,
        });
      } finally {
        setGeneratingKeys(false);
      }
    };
    void loadKeys();
  }, [currentWalletId]);

  return {
    keyPairs,
    generatingKeys,
    handleGenerateKeys,
  };
}
