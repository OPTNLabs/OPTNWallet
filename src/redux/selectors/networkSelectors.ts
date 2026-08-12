// src/redux/selectors/networkSelectors.ts

import { RootState } from '../store';
import { Network } from '../networkSlice';

export const selectCurrentNetwork = (state: RootState): Network => {
  return state.network.currentNetwork;
};
