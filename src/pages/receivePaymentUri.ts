export type BchPaymentRequestFields = {
  amount?: string;
  label?: string;
  message?: string;
};

/** Accept plain positive BCH decimals with at most one satoshi's precision. */
export function isValidBchPaymentAmount(value: string): boolean {
  const amount = value.trim();
  if (!/^\d+(?:\.\d{1,8})?$/.test(amount)) return false;
  return /[1-9]/.test(amount);
}

/** Accept one locale decimal separator while preserving unsupported input. */
export function normalizeBchPaymentAmountInput(value: string): string {
  if (value.includes('.') || (value.match(/,/g)?.length ?? 0) !== 1) {
    return value;
  }
  return value.replace(',', '.');
}

/** Build a BCH BIP21-style URI without duplicating the mainnet CashAddr prefix. */
export function buildBchPaymentUri(
  address: string,
  fields: BchPaymentRequestFields = {}
): string {
  if (!address) return '';

  // The CashAddr mainnet prefix is already represented by the URI scheme.
  // Testnet/regtest prefixes identify a different network and must remain.
  const uriAddress = address.replace(/^bitcoincash:/i, '');
  const params = new URLSearchParams();
  for (const key of ['amount', 'label', 'message'] as const) {
    const value = fields[key]?.trim();
    if (value) params.set(key, value);
  }

  const query = params.toString();
  return `bitcoincash:${uriAddress}${query ? `?${query}` : ''}`;
}
