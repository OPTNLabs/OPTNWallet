export function maskSensitiveValue(
  value: string,
  prefixLength = 4,
  suffixLength = 4
): string {
  if (!value) return '';
  if (value.length <= prefixLength + suffixLength) return value;
  return `${value.slice(0, prefixLength)}${'*'.repeat(
    Math.max(4, value.length - prefixLength - suffixLength)
  )}${value.slice(-suffixLength)}`;
}
