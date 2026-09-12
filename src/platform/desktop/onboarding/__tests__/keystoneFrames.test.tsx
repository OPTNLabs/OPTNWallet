/** @vitest-environment jsdom */
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const { parse } = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock('../../../../apis/DatabaseManager/DatabaseService', () => ({
  default: vi.fn(),
}));
vi.mock('../../../../apis/WalletManager/WalletManager', () => ({
  default: vi.fn(),
}));
vi.mock('../watchOnlyWallet', () => ({
  createWatchOnlyWallet: vi.fn(),
  createWatchOnlyMultisigWallet: vi.fn(),
}));
vi.mock('../../../../services/psbt/multisigWallet', () => ({
  MAX_COSIGNERS: 15,
  deriveMultisigAddress: vi.fn(),
  parsePmwif: vi.fn(),
  pmwifFilename: vi.fn(),
  serializePmwif: vi.fn(),
}));
vi.mock('../../barcode-scanner', () => ({ CapacitorBarcodeScanner: {} }));
vi.mock('../../../../i18n/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('../../../../services/psbt/keystoneAccount', () => ({
  parseKeystoneAccount: parse,
  isBchAccountPath: () => true,
}));
vi.mock('../../CameraQrScanner', () => ({
  CameraQrScanner: ({ onResult }: { onResult: (text: string) => void }) => (
    <button
      onClick={() => {
        onResult('frame-one');
        onResult('frame-two');
      }}
    >
      two frames
    </button>
  ),
}));
import { WatchOnlyWalletPreview } from '../WatchOnlyWalletPreview';

afterEach(cleanup);
it('retains frames arriving in one render batch', () => {
  parse.mockImplementation((frames: string[]) => {
    if (frames.length < 2) throw new Error('part of the animated export');
    return {
      masterFingerprintHex: '11223344',
      accountPath: "m/44'/145'/0'",
      accountXpub: 'public-test',
    };
  });
  render(<WatchOnlyWalletPreview onBack={() => {}} onCreated={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: /Keystone/ }));
  fireEvent.click(screen.getByRole('button', { name: 'watchOnly.scanCamera' }));
  fireEvent.click(screen.getByRole('button', { name: 'two frames' }));
  expect(parse).toHaveBeenCalledWith(['frame-one', 'frame-two']);
  expect(screen.getByText('11223344')).toBeTruthy();
});
