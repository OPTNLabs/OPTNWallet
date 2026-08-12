import { decodeCashAddress, encodeCashAddress } from '@bitauth/libauth';

function toTokenAddress(address: string) {
    console.log('toTokenAddress() called for address: ' + address);
    const addressInfo: any  = (decodeCashAddress as any)(address);
    const pkhPayoutBin = addressInfo.payload;
    const prefix = addressInfo.prefix;
    const tokenAddress = (encodeCashAddress as any)(
      prefix,
      'p2pkhWithTokens',
      pkhPayoutBin
    );
    console.log('toTokenAddress() converted to: ' + tokenAddress);
    return tokenAddress;
}

export default toTokenAddress;
