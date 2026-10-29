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
  shareWithFeedback,
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
  it('shares a public value and reports success without exposing it in the toast', async () => {
    mocks.native.mockReturnValue(false);
    vi.stubGlobal('navigator', {
      share: vi.fn().mockResolvedValue(undefined),
    });

    await expect(
      shareWithFeedback(
        { title: 'Receive', text: 'disposable receive address' },
        'receive.addressShared'
      )
    ).resolves.toBe(true);
    expect(document.querySelector('[role=status]')?.textContent).toBe(
      'Address ready to share'
    );
    expect(document.body.textContent).not.toContain(
      'disposable receive address'
    );
  });
  it('reports share unavailability without throwing', async () => {
    mocks.native.mockReturnValue(false);
    vi.stubGlobal('navigator', {});

    await expect(shareWithFeedback({ text: 'public address' })).resolves.toBe(
      false
    );
    expect(document.querySelector('[role=status]')?.textContent).toContain(
      'Sharing is unavailable'
    );
  });
  it('preserves share success when the notification presenter fails', async () => {
    mocks.native.mockReturnValue(false);
    vi.stubGlobal('navigator', {
      share: vi.fn().mockResolvedValue(undefined),
    });
    vi.spyOn(document.body, 'appendChild').mockImplementationOnce(() => {
      throw new Error('presenter unavailable');
    });

    await expect(shareWithFeedback({ text: 'public address' })).resolves.toBe(
      true
    );
  });
  it('does not show an error when the user cancels sharing', async () => {
    mocks.native.mockReturnValue(false);
    vi.stubGlobal('navigator', {
      share: vi
        .fn()
        .mockRejectedValue(new DOMException('cancelled', 'AbortError')),
    });

    await expect(shareWithFeedback({ text: 'public address' })).resolves.toBe(
      false
    );
    expect(document.querySelector('[role=status]')).toBeNull();
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
