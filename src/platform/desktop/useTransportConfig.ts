// Share transport settings across every window, EC's process-config tier.
//
// Loaded once per window at startup and written back whenever they change, so
// configuring Tor or the relay pool in one window applies everywhere instead of
// being stranded in that window's throwaway redux partition.

import { useEffect, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import {
  selectFusionServer,
  selectFusionServers,
  selectNostrRelays,
  selectTorAuto,
  selectTorEnabled,
  selectTorHost,
  selectTorPortManual,
  setFusionServer,
  setFusionServers,
  setNostrRelays,
  setTorAuto,
  setTorEnabled,
  setTorHost,
  setTorPortManual,
} from '../../state/slices/experimentalSlice';
import { readTransportConfig, writeTransportConfig } from './transportConfig';
import { ensureTorAvailable } from './FusionTorResolver';
import { readChainTransport } from './chainSourcesBridge';
import { setRendererNetwork } from './rendererNetwork';
import type { RootState } from '../../state/store';

export function useTransportConfig(): void {
  const dispatch = useDispatch();
  const torEnabled = useSelector(selectTorEnabled);
  const torAuto = useSelector(selectTorAuto);
  const torHost = useSelector(selectTorHost);
  const torPortManual = useSelector(selectTorPortManual);
  const fusionServer = useSelector(selectFusionServer);
  const fusionServers = useSelector(selectFusionServers);
  const nostrRelays = useSelector(selectNostrRelays);
  const network = useSelector(
    (state: RootState) => state.network.currentNetwork
  );
  // Set while rendering, not in an effect: child effects run first, and the
  // requests they make must already answer to this window's network. A
  // network Rust adds to the runtime's can only make a route stricter.
  setRendererNetwork(network);

  /** Until the stored config has been applied, writes would persist defaults. */
  const loaded = useRef(false);
  /** The stored flag, used only if the Rust policy cannot be read. */
  const fallbackTor = useRef(torEnabled);
  const torEnsured = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    const stored = readTransportConfig();
    if (stored) {
      // Applied field by field: a config written by an older build may not carry
      // every key, and absent keys must keep the current value rather than reset
      // it.
      if (stored.torEnabled !== undefined) {
        dispatch(setTorEnabled(stored.torEnabled));
      }
      if (stored.torAuto !== undefined) dispatch(setTorAuto(stored.torAuto));
      if (stored.torHost !== undefined) dispatch(setTorHost(stored.torHost));
      if (stored.torPortManual !== undefined) {
        dispatch(setTorPortManual(stored.torPortManual));
      }
      if (stored.fusionServer !== undefined) {
        dispatch(setFusionServer(stored.fusionServer));
      }
      if (stored.fusionServers !== undefined) {
        dispatch(setFusionServers(stored.fusionServers));
      }
      if (stored.nostrRelays !== undefined) {
        dispatch(setNostrRelays(stored.nostrRelays));
      }
    }
    fallbackTor.current = stored?.torEnabled ?? torEnabled;
    loaded.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: the stored config is applied once
  }, [dispatch]);

  // Whether Tor is on is the network policy's answer in Rust (Settings →
  // Servers → Privacy & Transport), read per network. The flag mirrors it for
  // the Fusion and Cash Code paths, which Rust checks again regardless.
  useEffect(() => {
    if (!loaded.current) return;
    let cancelled = false;
    void readChainTransport(network)
      .then(
        (transport) => transport !== 'direct',
        () => fallbackTor.current
      )
      .then((enabled) => {
        if (cancelled) return;
        dispatch(setTorEnabled(enabled));
        // Ensure Tor is available on wallet open: check system Tor (9050/9150)
        // first, start the built-in process only if neither is found. Once per
        // window.
        if (enabled && !torEnsured.current) {
          torEnsured.current = true;
          void ensureTorAvailable({
            enabled: true,
            auto: torAuto,
            host: torHost,
            manualPort: torPortManual,
          });
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per network: re-running on Tor detail edits would re-start Tor
  }, [dispatch, network]);

  useEffect(() => {
    if (!loaded.current) return;
    writeTransportConfig({
      torEnabled,
      torAuto,
      torHost,
      torPortManual,
      fusionServer,
      fusionServers,
      nostrRelays,
    });
  }, [
    torEnabled,
    torAuto,
    torHost,
    torPortManual,
    fusionServer,
    fusionServers,
    nostrRelays,
  ]);
}
