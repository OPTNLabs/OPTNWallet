import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import WalletScreen from '../WalletScreen';

describe('WalletScreen', () => {
  it('reserves the bottom nav area and keeps scrolling inside the container', () => {
    const html = renderToStaticMarkup(
      <WalletScreen maxWidthClassName="max-w-md">
        <div>Wallet content</div>
      </WalletScreen>
    );

    expect(html).toContain('h-[calc(100dvh-var(--navbar-height)-var(--safe-bottom))]');
    expect(html).toContain('overflow-hidden');
    expect(html).toContain('overflow-y-auto');
    expect(html).toContain('overscroll-contain');
    expect(html).toContain('touch-pan-y');
  });

  it('can fit a constrained workspace and reserve the fixed nav inset', () => {
    const html = renderToStaticMarkup(
      <WalletScreen
        fitParent
        reserveBottomNavSpace
        scrollable={false}
      >
        <div>Workspace content</div>
      </WalletScreen>
    );

    expect(html).toContain('h-full min-h-0');
    expect(html).toContain(
      'pb-[calc(var(--navbar-height)+var(--safe-bottom)+1rem)]'
    );
    expect(html).not.toContain(
      'h-[calc(100dvh-var(--navbar-height)-var(--safe-bottom))]'
    );
  });
});
