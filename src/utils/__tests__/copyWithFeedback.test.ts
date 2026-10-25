/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  copy: vi.fn(),
  native: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('../clipboard', () => ({ copyToClipboard: mocks.copy }));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: mocks.native },
}));
vi.mock('@capacitor/toast', () => ({ Toast: { show: mocks.toast } }));
import {
  copyWithFeedback,
  showWalletNotification,
  showWalletStatus,
} from '../copyWithFeedback';
afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
  vi.useRealTimers();
});
describe('copy feedback', () => {
  it('reports clipboard failure without claiming success', async () => {
    mocks.native.mockReturnValue(false);
    mocks.copy.mockResolvedValue(false);
    expect(await copyWithFeedback('public test address')).toBe(false);
    expect(document.querySelector('[role=status]')?.textContent).toContain(
      'Failed to copy'
    );
  });
  it('preserves a successful copy when the native notification fails', async () => {
    mocks.native.mockReturnValue(true);
    mocks.copy.mockResolvedValue(true);
    mocks.toast.mockRejectedValue(new Error('unavailable'));
    expect(await copyWithFeedback('public test address')).toBe(true);
    expect(document.querySelector('[role=status]')?.textContent).toBe(
      'Copied to clipboard!'
    );
    expect(document.body.textContent).not.toContain('public test address');
  });
  it('preserves clipboard success when the browser presenter fails', async () => {
    mocks.native.mockReturnValue(false);
    mocks.copy.mockResolvedValue(true);
    vi.spyOn(document.body, 'appendChild').mockImplementationOnce(() => {
      throw new Error('presenter unavailable');
    });

    await expect(copyWithFeedback('public test address')).resolves.toBe(true);
  });
  it('uses contextual feedback without exposing the copied value', async () => {
    mocks.native.mockReturnValue(false);
    mocks.copy.mockResolvedValue(true);
    expect(
      await copyWithFeedback(
        'disposable receive address',
        'receive.addressCopied'
      )
    ).toBe(true);
    expect(document.querySelector('[role=status]')?.textContent).toBe(
      'Address copied'
    );
    expect(document.body.textContent).not.toContain(
      'disposable receive address'
    );
  });
  it('uses the native toast for transient notifications when available', async () => {
    mocks.native.mockReturnValue(true);
    mocks.toast.mockResolvedValue(undefined);
    await showWalletNotification('Pairing started');
    expect(mocks.toast).toHaveBeenCalledWith({ text: 'Pairing started' });
    expect(document.querySelector('[role=status]')).toBeNull();
  });
  it('falls back to an accessible wallet status when a native toast fails', async () => {
    mocks.native.mockReturnValue(true);
    mocks.toast.mockRejectedValue(new Error('unavailable'));
    await showWalletNotification('Pairing failed');
    expect(document.querySelector('[role=status]')?.textContent).toBe(
      'Pairing failed'
    );
  });
  it('replaces repeated notifications and expires the latest message', () => {
    vi.useFakeTimers();
    showWalletStatus('First');
    vi.advanceTimersByTime(1000);
    showWalletStatus('Second');
    expect(document.querySelectorAll('[role=status]')).toHaveLength(1);
    vi.advanceTimersByTime(2500);
    expect(document.body.textContent).toBe('Second');
    vi.advanceTimersByTime(1000);
    expect(document.body.textContent).toBe('');
  });
});
