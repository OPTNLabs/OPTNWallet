import KeyService from './KeyService';

const QuantumrootTrackingService = {
  async listTrackedAddresses(walletId: number): Promise<string[]> {
    const vaults = await KeyService.retrieveQuantumrootVaults(walletId);
    return Array.from(
      new Set(
        vaults.flatMap((vault) => [vault.receive_address, vault.quantum_lock_address])
      )
    ).filter(Boolean);
  },
};

export default QuantumrootTrackingService;
