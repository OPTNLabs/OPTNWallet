/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

import { openExternal } from '../openExternal';

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe('openExternal', () => {
  it('opens the selected URL in the system browser', async () => {
    mocks.invoke.mockResolvedValue(undefined);
    expect(await openExternal('https://explorer.example/tx/id')).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith('open_external', {
      url: 'https://explorer.example/tx/id',
    });
    expect(document.querySelector('[role=status]')).toBeNull();
  });

  it('surfaces a failed system-browser open', async () => {
    mocks.invoke.mockRejectedValue(new Error('shell unavailable'));
    expect(await openExternal('https://explorer.example/tx/id')).toBe(false);
    expect(document.querySelector('[role=status]')?.textContent).toBe(
      'Could not open the browser. Please try again.'
    );
  });
});
