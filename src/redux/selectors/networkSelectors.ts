import { RootState } from '../store';

export const selectCurrentNetwork = (state: RootState) =>
  state.network.currentNetwork;
