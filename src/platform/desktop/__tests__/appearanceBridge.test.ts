import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('../../../utils/platform', () => ({ isDesktopPlatform: () => true }));

const { persistEngineAppearance, readEngineAppearance } = await import(
  '../appearanceBridge'
);

describe('appearance bridge', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('reads the mode and skin the shared runtime holds', async () => {
    invoke.mockResolvedValueOnce({ theme: 'gray', skin: 'cyberpunk' });
    await expect(readEngineAppearance()).resolves.toEqual({
      mode: 'gray',
      skin: 'cyberpunk',
    });
    expect(invoke).toHaveBeenCalledWith('optn_app_snapshot');
  });

  it('treats an unreadable snapshot as no answer, not as a theme change', async () => {
    // Returning a default here would silently repaint the wallet whenever the
    // host hiccuped, so the caller keeps whatever it already had.
    invoke.mockResolvedValueOnce({ theme: 'sepia' });
    await expect(readEngineAppearance()).resolves.toBeNull();

    invoke.mockRejectedValueOnce(new Error('runtime is closed'));
    await expect(readEngineAppearance()).resolves.toBeNull();
  });

  it('defaults only the skin when the runtime predates skins', async () => {
    invoke.mockResolvedValueOnce({ theme: 'green' });
    await expect(readEngineAppearance()).resolves.toEqual({
      mode: 'green',
      skin: 'default',
    });
  });

  it('dispatches both selections in the versioned wire shape', async () => {
    invoke.mockResolvedValue(undefined);
    await persistEngineAppearance({ mode: 'dark', skin: 'cyberpunk' });
    expect(invoke).toHaveBeenNthCalledWith(1, 'optn_app_dispatch', {
      action: { version: 1, action: { type: 'set_theme', value: 'dark' } },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'optn_app_dispatch', {
      action: { version: 1, action: { type: 'set_skin', value: 'cyberpunk' } },
    });
  });

  it('reports a failed save instead of swallowing it', async () => {
    invoke.mockRejectedValueOnce(new Error('appearance could not be saved'));
    await expect(
      persistEngineAppearance({ mode: 'gray', skin: 'default' })
    ).rejects.toThrow(/could not be saved/);
  });
});
