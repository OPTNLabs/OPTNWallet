import { UTXO } from '../../types/types';

export function getFilteredRegularUTXOs(
  utxos: UTXO[],
  selectedAddresses: string[]
) {
  return utxos.filter((u) => selectedAddresses.includes(u.address) && !u.token);
}

export function getFilteredCashTokenUTXOs(
  utxos: UTXO[],
  selectedAddresses: string[]
) {
  return utxos.filter((u) => selectedAddresses.includes(u.address) && !!u.token);
}

export function getFilteredContractUTXOs(
  contractUTXOs: UTXO[],
  selectedContractAddresses: string[]
) {
  return contractUTXOs.filter((u) =>
    selectedContractAddresses.includes(u.address)
  );
}

export function getTotalSelectedUtxoAmount(selectedUtxos: UTXO[]) {
  return selectedUtxos.reduce(
    (sum, u) => sum + BigInt(u.amount || u.value),
    BigInt(0)
  );
}
