export const shortenHash = (
  value: string,
  prefixLength: number = 4,
  suffixLength: number = 4
) => {
  if (!value) return '';
  if (value.length <= prefixLength + suffixLength + 3) return value;
  return `${value.slice(0, prefixLength)}...${value.slice(-suffixLength)}`;
};

export const shortenTxHash = (txHash: string, prefixLength: number = 0) => {
  if (!txHash) return '';

  const visibleLength = prefixLength + 6; // Length of prefix + 6 additional characters

  return `${txHash.slice(0, visibleLength)}**********${txHash.slice(-5)}`;
};

export const shortenAddress = (address: string) => {
  if (!address) return '';

  // For BCH addresses, show prefix + first 8 + ... + last 8
  const parts = address.split(':');
  const prefix = parts.length > 1 ? `${parts[0]}:${parts[1].slice(0, 1)}` : '';
  const addr = parts[parts.length - 1];

  if (addr.length <= 20) return address; // No need to shorten short addresses

  return `${prefix}${addr.slice(0, 8)}...${addr.slice(-8)}`;
};
