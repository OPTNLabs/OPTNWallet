import { describe, expect, it } from 'vitest';

import { Network } from '../../state/slices/networkSlice';
import { PREFIX } from '../constants';
import {
  cashAddressPrefix,
  isTestNetwork,
  NETWORK_PROFILES,
  networkProfile,
  parseNetwork,
  SELECTABLE_NETWORKS,
} from '../networkProfile';
import { getElectrumServers } from '../servers/InfraUrls';
import { defaultNodePort } from '../servers/userNodes';
import { unitFor } from '../unitLabel';

const ALL = Object.values(Network);
const TEST_NETWORKS = [Network.TESTNET3, Network.TESTNET4, Network.CHIPNET];

describe('network profiles', () => {
  it('has exactly one row per Network value, keyed by its own value', () => {
    expect(Object.keys(NETWORK_PROFILES).sort()).toEqual([...ALL].sort());
    for (const network of ALL) {
      expect(networkProfile(network).network).toBe(network);
    }
  });

  it('offers every network once, in the Rust selector order', () => {
    expect(SELECTABLE_NETWORKS).toEqual([
      Network.MAINNET,
      Network.TESTNET3,
      Network.TESTNET4,
      Network.CHIPNET,
    ]);
    expect(new Set(SELECTABLE_NETWORKS).size).toBe(ALL.length);
  });

  it('parses only exact network names and never guesses', () => {
    for (const network of ALL) {
      expect(parseNetwork(network)).toBe(network);
    }
    for (const value of [
      '',
      'Mainnet',
      'testnet',
      'regtest',
      'toString',
      null,
      undefined,
      1,
    ]) {
      expect(parseNetwork(value)).toBeUndefined();
    }
  });

  it('gives mainnet bitcoincash, xpub and coin type 145', () => {
    const mainnet = networkProfile(Network.MAINNET);
    expect(mainnet.cashAddressPrefix).toBe('bitcoincash');
    expect(mainnet.hdNetwork).toBe('mainnet');
    expect(mainnet.coinType).toBe(145);
    expect(mainnet.unit).toBe('BCH');
    expect(isTestNetwork(Network.MAINNET)).toBe(false);
  });

  it('gives every test network bchtest, tpub, coin type 1 and tBCH', () => {
    for (const network of TEST_NETWORKS) {
      const profile = networkProfile(network);
      expect(profile.cashAddressPrefix).toBe('bchtest');
      expect(profile.hdNetwork).toBe('testnet');
      expect(profile.coinType).toBe(1);
      expect(profile.discoveryCoinTypes[0]).toBe(1);
      expect(unitFor(network)).toBe('tBCH');
      expect(isTestNetwork(network)).toBe(true);
    }
  });

  it('keeps the PREFIX enum equal to the profile prefix', () => {
    for (const network of ALL) {
      expect(PREFIX[network]).toBe(cashAddressPrefix(network));
    }
  });

  it('defaults bare node hosts to each network P2P port', () => {
    expect(defaultNodePort(Network.MAINNET)).toBe(8333);
    expect(defaultNodePort(Network.TESTNET3)).toBe(18333);
    expect(defaultNodePort(Network.TESTNET4)).toBe(28333);
    expect(defaultNodePort(Network.CHIPNET)).toBe(48333);
  });

  it('ships Electrum servers for every network', () => {
    for (const network of ALL) {
      expect(getElectrumServers(network).length).toBeGreaterThan(0);
    }
  });

  // c3-soft and loping serve several networks from one host name and pick the
  // network by port; a bare host would reach whichever network sits on 50004.
  it('pins the port for testnet hosts shared across networks', () => {
    for (const network of [Network.TESTNET3, Network.TESTNET4]) {
      for (const server of getElectrumServers(network)) {
        if (/c3-soft\.com|loping\.net/.test(server)) {
          expect(server).toMatch(/:\d+$/);
        }
      }
    }
  });
});
