import { describe, expect, it, vi } from 'vitest';

import {
  automaticImportPath,
  importDiscoveryIsBlocking,
  isValidImportMnemonic,
  scheduleCancelable,
} from '../useImportDerivationDiscovery';
import type { DerivationDiscoveryState } from '../useDerivationDiscovery';

const completeUnique: DerivationDiscoveryState = {
  status: 'done',
  result: {
    chosen: "m/44'/0'/0'",
    ambiguous: false,
    incomplete: false,
    candidatesProbed: 4,
    candidatesTotal: 4,
    probed: [{ path: "m/44'/0'/0'", usedAddresses: 2, satoshis: 10_000n }],
  },
};

describe('import derivation-discovery decisions', () => {
  it('requires a checksum-valid BIP39 phrase before scanning or importing', () => {
    expect(
      isValidImportMnemonic(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
      )
    ).toBe(true);
    expect(
      isValidImportMnemonic(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon'
      )
    ).toBe(false);
  });

  it('auto-adopts only a complete, unambiguous result', () => {
    expect(automaticImportPath(completeUnique)).toBe("m/44'/0'/0'");
    expect(
      automaticImportPath({
        ...completeUnique,
        result: { ...completeUnique.result, incomplete: true },
      })
    ).toBeNull();
    expect(
      automaticImportPath({
        ...completeUnique,
        result: { ...completeUnique.result, ambiguous: true },
      })
    ).toBeNull();
  });

  it('blocks import while scanning or awaiting an ambiguity choice', () => {
    expect(importDiscoveryIsBlocking({ status: 'idle' }, null, true)).toBe(
      true
    );
    expect(
      importDiscoveryIsBlocking(
        { status: 'scanning', completed: 1, total: 4 },
        null
      )
    ).toBe(true);
    expect(
      importDiscoveryIsBlocking(
        {
          ...completeUnique,
          result: { ...completeUnique.result, ambiguous: true },
        },
        null
      )
    ).toBe(true);
    expect(
      importDiscoveryIsBlocking(
        {
          ...completeUnique,
          result: { ...completeUnique.result, ambiguous: true },
        },
        "m/44'/0'/0'"
      )
    ).toBe(false);
  });

  it('does not trap import after a failed or incomplete scan', () => {
    expect(
      importDiscoveryIsBlocking({ status: 'failed', message: 'offline' }, null)
    ).toBe(false);
    expect(
      importDiscoveryIsBlocking(
        {
          ...completeUnique,
          result: { ...completeUnique.result, incomplete: true },
        },
        null
      )
    ).toBe(false);
  });

  it('cancels a scan queued by the import debounce', () => {
    vi.useFakeTimers();
    try {
      const startScan = vi.fn();
      const cancel = scheduleCancelable(startScan, 600);

      cancel();
      vi.advanceTimersByTime(600);

      expect(startScan).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
