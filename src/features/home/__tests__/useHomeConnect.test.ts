import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const homeSource = readFileSync(
  fileURLToPath(new URL('../Home.tsx', import.meta.url)),
  'utf8'
);
const desktopHomeSource = readFileSync(
  fileURLToPath(
    new URL('../../../platform/desktop/DesktopHome.tsx', import.meta.url)
  ),
  'utf8'
);
const hookSource = readFileSync(
  fileURLToPath(new URL('../useHomeConnect.ts', import.meta.url)),
  'utf8'
);

describe('Home connect popup', () => {
  it('opens from Home Scan QR instead of only launching the camera', () => {
    expect(homeSource).toContain('useHomeConnect');
    expect(homeSource).toContain('HomeConnectPopup');
    expect(homeSource).toContain('homeConnect.openPopup');
    expect(desktopHomeSource).toContain('useHomeConnect');
    expect(desktopHomeSource).toContain('HomeConnectPopup');
    expect(desktopHomeSource).toContain('homeConnect.openPopup');
  });

  it('pairs CashConnect and WalletConnect on Home so approve overlays can show', () => {
    expect(hookSource).toContain('pairCashConnectThunk');
    expect(hookSource).toContain('wcPair');
    expect(hookSource).toContain('kind === \'cashconnect\'');
    expect(hookSource).toContain('kind === \'walletconnect\'');
    expect(hookSource).toContain('setPopupOpen(false)');
  });
});
