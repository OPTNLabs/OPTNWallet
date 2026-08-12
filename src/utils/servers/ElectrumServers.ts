import { Network } from '../../redux/networkSlice';
import { getElectrumServers as getInfraElectrumServers } from './InfraUrls';

// Backward-compatible exports (resolved once), plus a runtime getter.
export const chipnetServers = getInfraElectrumServers(Network.CHIPNET);
export const mainnetServers = getInfraElectrumServers(Network.MAINNET);

export function getElectrumServers(network: Network): string[] {
  return getInfraElectrumServers(network);
}
