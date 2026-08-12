import { decodeCashAddress, encodeCashAddress } from '@bitauth/libauth';

export function toTokenAwareCashAddress(address: string): string {
  const decoded = decodeCashAddress(address);
  if (typeof decoded === 'string') {
    throw new Error(`Invalid recipient address: ${address}`);
  }

  if (
    decoded.type === 'p2pkhWithTokens' ||
    decoded.type === 'p2shWithTokens'
  ) {
    return address;
  }

  if (decoded.type === 'p2pkh') {
    return encodeCashAddress({
      prefix: decoded.prefix,
      type: 'p2pkhWithTokens',
      payload: decoded.payload,
    }).address;
  }

  if (decoded.type === 'p2sh') {
    return encodeCashAddress({
      prefix: decoded.prefix,
      type: 'p2shWithTokens',
      payload: decoded.payload,
    }).address;
  }

  throw new Error(`Unsupported token recipient address type: ${address}`);
}
