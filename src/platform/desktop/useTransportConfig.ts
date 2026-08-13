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

export function useTransportConfig(): void {
  const dispatch = useDispatch();
  const torEnabled = useSelector(selectTorEnabled);
  const torAuto = useSelector(selectTorAuto);
  const torHost = useSelector(selectTorHost);
  const torPortManual = useSelector(selectTorPortManual);
  const fusionServer = useSelector(selectFusionServer);
  const fusionServers = useSelector(selectFusionServers);
  const nostrRelays = useSelector(selectNostrRelays);

  /** Until the stored config has been applied, writes would persist defaults. */
  const loaded = useRef(false);

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
    loaded.current = true;
  }, [dispatch]);

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
