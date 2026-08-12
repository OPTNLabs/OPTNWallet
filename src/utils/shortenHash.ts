export const shortenTxHash = (txHash: string, prefixLength: number = 0) => {
  if (!txHash) return '';

  const visibleLength = prefixLength + 6; // Length of prefix + 6 additional characters

  return `${txHash.slice(0, visibleLength)}**********${txHash.slice(-5)}`;
};
