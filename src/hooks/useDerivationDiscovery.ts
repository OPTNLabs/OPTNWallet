// Run a derivation-path scan and hold its state for the UI.
//
// Kept separate from the two screens that use it (import and settings) so both
// present the same states and neither reimplements cancellation.

import { useCallback, useEffect, useRef, useState } from 'react';

import { Network } from '../state/slices/networkSlice';
import {
  scanDerivationPaths,
  type AccountXpubResolver,
  type DerivationScanResult,
} from '../services/DerivationPathProbe';

export type DerivationDiscoveryState =
  | { status: 'idle' }
  | { status: 'scanning'; completed: number; total: number }
  | { status: 'done'; result: DerivationScanResult }
  | { status: 'failed'; message: string };

export interface UseDerivationDiscovery {
  state: DerivationDiscoveryState;
  scan: (network: Network, resolveXpubs: AccountXpubResolver) => Promise<void>;
  cancel: () => void;
  reset: () => void;
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'AbortError' || error.name === 'ABORT_ERR')
  );
}

export function useDerivationDiscovery(): UseDerivationDiscovery {
  const [state, setState] = useState<DerivationDiscoveryState>({
    status: 'idle',
  });
  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // A scan outlives the screen that started it otherwise, and keeps making
      // requests for a path nobody is going to adopt.
      controllerRef.current?.abort();
    };
  }, []);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    if (mountedRef.current) setState({ status: 'idle' });
  }, []);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    if (mountedRef.current) setState({ status: 'idle' });
  }, []);

  const scan = useCallback(
    async (network: Network, resolveXpubs: AccountXpubResolver) => {
      // Replace any scan already running — the network or seed just changed, so
      // its answer would be for the wrong question.
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      setState({ status: 'scanning', completed: 0, total: 0 });

      try {
        const result = await scanDerivationPaths(network, resolveXpubs, {
          signal: controller.signal,
          onProgress: (completed, total) => {
            if (!mountedRef.current || controller.signal.aborted) return;
            setState({ status: 'scanning', completed, total });
          },
        });
        if (!mountedRef.current || controller.signal.aborted) return;
        setState({ status: 'done', result });
      } catch (error) {
        // Cancelling is a choice, not a failure — say nothing and go back to
        // idle rather than showing the user an error they caused on purpose.
        if (isAbort(error)) return;
        if (!mountedRef.current) return;
        setState({
          status: 'failed',
          message:
            error instanceof Error
              ? error.message
              : 'Could not check derivation paths.',
        });
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null;
      }
    },
    []
  );

  return { state, scan, cancel, reset };
}

export default useDerivationDiscovery;
