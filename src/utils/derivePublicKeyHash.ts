// src/utils/derivePublicKeyHash.ts

import {
  CashAddressNetworkPrefix,
  decodeCashAddressFormat,
  decodeCashAddressFormatWithoutPrefix,
} from '@bitauth/libauth';

/**
 * derivePrefix - Extract the address prefix
 *
 * @param {string} address - Address with or without prefix
 * @returns {CashAddressNetworkPrefix} - The address prefix
 */
export function derivePrefix(address: string): CashAddressNetworkPrefix {
  let result:
    | string
    | {
        payload: Uint8Array;
        prefix: string;
        version: number;
      };

  if (address.includes(':')) {
    result = decodeCashAddressFormat(address);
  } else {
    result = decodeCashAddressFormatWithoutPrefix(address);
  }

  if (typeof result === 'string') throw new Error(result);

  return result.prefix as CashAddressNetworkPrefix;
}
