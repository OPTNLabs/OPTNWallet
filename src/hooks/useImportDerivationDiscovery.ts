import * as bip39 from 'bip39';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Network } from '../state/slices/networkSlice';
import { mnemonicXpubResolver } from '../services/DerivationPathProbe';
import {
  useDerivationDiscovery,
  type DerivationDiscoveryState,
} from './useDerivationDiscovery';

const DEFAULT_SCAN_DEBOUNCE_MS = 600;

export function scheduleCancelable(
  callback: () => void,
  delayMs: number
): () => void {
  const timeout = globalThis.setTimeout(callback, delayMs);
  return () => globalThis.clearTimeout(timeout);
}

export function isValidImportMnemonic(mnemonic: string): boolean {
  return bip39.validateMnemonic(mnemonic);
}

export function automaticImportPath(
  state: DerivationDiscoveryState
): string | null {
  if (
    state.status !== 'done' ||
    state.result.incomplete ||
    state.result.ambiguous
  ) {
    return null;
  }
  return state.result.chosen;
}

export function importDiscoveryIsBlocking(
  state: DerivationDiscoveryState,
  selectedPath: string | null,
  pending = false
): boolean {
  if (pending) return true;
  if (state.status === 'scanning') return true;
  return (
    state.status === 'done' &&
    !state.result.incomplete &&
    state.result.ambiguous &&
    selectedPath === null
  );
}

interface Options {
  enabled: boolean;
  network: Network;
  mnemonic: string;
  passphrase: string;
  onAdopt: (path: string) => void;
  debounceMs?: number;
}

export interface ImportDerivationDiscovery {
  state: DerivationDiscoveryState;
  selectedPath: string | null;
  blocking: boolean;
  cancel: () => void;
  retry: () => void;
  selectPath: (path: string) => void;
}

/**
 * Automatically scan once a complete, checksum-valid import phrase is ready.
 *
 * The debounce prevents the last word's individual keystrokes from starting
 * repeated network scans. An incomplete or invalid phrase remains entirely
 * local and no derived address is sent to Electrum.
 */
export function useImportDerivationDiscovery({
  enabled,
  network,
  mnemonic,
  passphrase,
  onAdopt,
  debounceMs = DEFAULT_SCAN_DEBOUNCE_MS,
}: Options): ImportDerivationDiscovery {
  const { state, scan, cancel } = useDerivationDiscovery();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const autoAdoptedPathRef = useRef<string | null>(null);
  const cancelQueuedRef = useRef<() => void>(() => undefined);
  const validMnemonic = enabled && isValidImportMnemonic(mnemonic);
  const resolver = useMemo(
    () =>
      validMnemonic
        ? mnemonicXpubResolver(network, mnemonic, passphrase)
        : null,
    [mnemonic, network, passphrase, validMnemonic]
  );

  const startScan = useCallback(() => {
    if (!resolver) return;
    setPending(false);
    setSelectedPath(null);
    void scan(network, resolver);
  }, [network, resolver, scan]);

  const cancelQueued = useCallback(() => {
    cancelQueuedRef.current();
    cancelQueuedRef.current = () => undefined;
  }, []);

  useEffect(() => {
    // A changed network or phrase makes the prior answer irrelevant. Abort it
    // immediately; debounce only the start of the replacement scan.
    cancelQueued();
    cancel();
    setPending(false);
    setSelectedPath(null);
    if (!resolver) return;

    setPending(true);
    cancelQueuedRef.current = scheduleCancelable(() => {
      cancelQueuedRef.current = () => undefined;
      startScan();
    }, debounceMs);
    return cancelQueued;
  }, [cancel, cancelQueued, debounceMs, resolver, startScan]);

  useEffect(() => {
    if (state.status === 'scanning' && state.completed === 0) {
      autoAdoptedPathRef.current = null;
    }
  }, [state]);

  const autoPath = automaticImportPath(state);
  useEffect(() => {
    if (!autoPath || autoAdoptedPathRef.current === autoPath) return;
    autoAdoptedPathRef.current = autoPath;
    setSelectedPath(autoPath);
    onAdopt(autoPath);
  }, [autoPath, onAdopt]);

  const retry = useCallback(() => {
    autoAdoptedPathRef.current = null;
    setPending(false);
    cancelQueued();
    startScan();
  }, [cancelQueued, startScan]);

  const stop = useCallback(() => {
    cancelQueued();
    setPending(false);
    cancel();
  }, [cancel, cancelQueued]);

  const selectPath = useCallback(
    (path: string) => {
      setSelectedPath(path);
      onAdopt(path);
    },
    [onAdopt]
  );

  return {
    state,
    selectedPath,
    blocking: importDiscoveryIsBlocking(state, selectedPath, pending),
    cancel: stop,
    retry,
    selectPath,
  };
}

export default useImportDerivationDiscovery;
