export const CAIP2_BY_NETWORK: Record<string, string> = {
  mainnet: 'bch:bitcoincash',
  chipnet: 'bch:bchtest',
};

export const BCH_METHODS = [
  'bch_getAddresses',
  'bch_signMessage',
  'bch_signTransaction',
];

export const BCH_EVENTS = ['addressesChanged'];
