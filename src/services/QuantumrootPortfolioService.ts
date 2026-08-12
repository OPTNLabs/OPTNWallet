import KeyService from './KeyService';
import UTXOService from './UTXOService';

export type QuantumrootPortfolioSummary = {
  quantumrootBalanceSats: number;
  vaultCount: number;
};

function sumAddressBalances(utxosByAddress: Record<string, { value?: number; amount?: number }[]>) {
  return Object.values(utxosByAddress)
    .flat()
    .reduce((total, utxo) => total + (utxo.value ?? utxo.amount ?? 0), 0);
}

const QuantumrootPortfolioService = {
  async summarizeWallet(walletId: number): Promise<QuantumrootPortfolioSummary> {
    const vaults = await KeyService.retrieveQuantumrootVaults(walletId);
    if (vaults.length === 0) {
      return {
        quantumrootBalanceSats: 0,
        vaultCount: 0,
      };
    }

    const addresses = Array.from(
      new Set(
        vaults.flatMap((vault) => [vault.receive_address, vault.quantum_lock_address])
      )
    ).filter(Boolean);

    const utxosByAddress = await UTXOService.fetchAndStoreUTXOsMany(walletId, addresses);
    return {
      quantumrootBalanceSats: sumAddressBalances(utxosByAddress),
      vaultCount: vaults.length,
    };
  },
};

export default QuantumrootPortfolioService;
