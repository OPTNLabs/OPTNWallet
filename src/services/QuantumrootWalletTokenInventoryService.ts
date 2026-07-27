import type { UTXO } from '../types/types';
import {
  getCapabilityAwareFamilies,
  type TokenFamilySummary,
} from './cashtokens';

export type QuantumrootWalletTokenSummary = TokenFamilySummary;

export function summarizeQuantumrootWalletTokenInventory(
  utxos: UTXO[]
): QuantumrootWalletTokenSummary[] {
  return getCapabilityAwareFamilies(utxos);
}
