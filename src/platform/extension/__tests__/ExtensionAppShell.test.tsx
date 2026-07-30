import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { appShellMock } = vi.hoisted(() => ({
  appShellMock: vi.fn(() => null),
}));

vi.mock('../../../app/AppShell', () => ({
  default: appShellMock,
}));

vi.mock('../ExtensionSecurityGate', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import ExtensionAppShell from '../ExtensionAppShell';

describe('ExtensionAppShell', () => {
  beforeEach(() => {
    appShellMock.mockClear();
  });

  it('always mounts the shared shell in read-only viewer mode', () => {
    renderToStaticMarkup(<ExtensionAppShell />);

    expect(appShellMock).toHaveBeenCalledWith(
      expect.objectContaining({ viewerOnly: true }),
      expect.anything()
    );
  });
});
