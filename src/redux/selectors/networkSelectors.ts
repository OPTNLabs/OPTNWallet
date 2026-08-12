// src/redux/selectors/networkSelectors.ts

import { RootState } from '../store';
import { Network } from '../networkSlice';

export const selectCurrentNetwork = (state: RootState): Network => {
  if (state.wallet_id.currentWalletId > 0) {
    return state.wallet_id.networkType;
  }
  return state.network.currentNetwork;
};
