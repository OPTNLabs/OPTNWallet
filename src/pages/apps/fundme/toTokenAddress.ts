import { decodeCashAddress, encodeCashAddress } from '@bitauth/libauth';

type DecodedCashAddress = {
  prefix: string;
  payload: Uint8Array;
};

function toTokenAddress(address: string) {
    console.log('toTokenAddress() called for address: ' + address);
    const addressInfo = decodeCashAddress(address);
    if (typeof addressInfo === 'string') {
      throw new Error(`Failed to decode CashAddress: ${addressInfo}`);
    }

    const { payload: pkhPayoutBin, prefix } = addressInfo as DecodedCashAddress;
    const tokenAddress = encodeCashAddress({
      prefix: prefix as 'bitcoincash' | 'bchtest' | 'bchreg',
      type: 'p2pkhWithTokens',
      payload: pkhPayoutBin,
    }).address;
    console.log('toTokenAddress() converted to: ' + tokenAddress);
    return tokenAddress;
}

export default toTokenAddress;
