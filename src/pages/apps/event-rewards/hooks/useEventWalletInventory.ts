import { useEffect, useState } from 'react';
import type { AddonSDK } from '../../../../services/AddonsSDK';
import type { WalletAirdropAsset } from '../types';

type WalletInventoryState = {
  loading: boolean;
  error: string;
  addresses: { address: string; tokenAddress: string }[];
  passes: WalletAirdropAsset[];
  feeFundingSats: number;
  feeFundingUtxoCount: number;
};

export function useAirdropWalletInventory(sdk: AddonSDK) {
  const [state, setState] = useState<WalletInventoryState>({
    loading: true,
    error: '',
    addresses: [],
    passes: [],
    feeFundingSats: 0,
    feeFundingUtxoCount: 0,
  });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const [addresses, walletUtxos] = await Promise.all([
          sdk.wallet.listAddresses(),
          sdk.utxos.listForWallet(),
        ]);

        const byCategory = new Map<
          string,
          { commitments: Set<string>; amount: bigint }
        >();

        for (const utxo of walletUtxos.tokenUtxos) {
          const category = utxo.token?.category;
          if (!category) continue;
          const current = byCategory.get(category) ?? {
            commitments: new Set<string>(),
            amount: BigInt(0),
          };
          const amountRaw = utxo.token?.amount;
          const amount =
            typeof amountRaw === 'bigint'
              ? amountRaw
              : BigInt(amountRaw || 0);
          current.amount += amount;
          const commitment = utxo.token?.nft?.commitment;
          if (commitment) current.commitments.add(commitment);
          byCategory.set(category, current);
        }

        const passes: WalletAirdropAsset[] = Array.from(byCategory.entries()).map(
          ([category, value]) => ({
            category,
            nftCommitments: Array.from(value.commitments),
            tokenBalance: value.amount.toString(),
          })
        );

        const feeFundingUtxos = walletUtxos.allUtxos.filter((utxo) => !utxo.token);
        const feeFundingSats = feeFundingUtxos.reduce(
          (sum, utxo) => sum + Number(utxo.amount ?? utxo.value ?? 0),
          0
        );

        if (!cancelled) {
          setState({
            loading: false,
            error: '',
            addresses,
            passes,
            feeFundingSats,
            feeFundingUtxoCount: feeFundingUtxos.length,
          });
        }
      } catch (error) {
        if (!cancelled) {
          setState((prev) => ({
            ...prev,
            loading: false,
            error:
              error instanceof Error
                ? error.message
                : 'Failed to load wallet airdrop inventory.',
            feeFundingSats: 0,
            feeFundingUtxoCount: 0,
          }));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sdk]);

  return state;
}
