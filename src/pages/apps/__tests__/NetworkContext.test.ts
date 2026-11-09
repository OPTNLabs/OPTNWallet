import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const routeChromeSources = [
  'src/pages/apps/paryon/ParyonWorkspaceApp.tsx',
  'src/pages/apps/cauldron/CauldronSwapApp.tsx',
  'src/pages/apps/merchant-pay/MerchantPayApp.tsx',
].map((file) => readFileSync(join(process.cwd(), file), 'utf8'));
const airdropsSource = readFileSync(
  join(process.cwd(), 'src/pages/apps/airdrops/AirdropsApp.tsx'),
  'utf8'
);

describe('add-on network context', () => {
  it('uses the shared header and route-exit footer for app screens', () => {
    for (const source of routeChromeSources) {
      expect(source).toContain('PageHeader');
      expect(source).toContain('RouteExitFooter');
    }
    expect(airdropsSource).toContain('PageHeader');
  });

  it('keeps the Airdrop shell viewport-sized with distinct exit and step-back actions', () => {
    expect(airdropsSource).toContain(
      'h-[calc(100dvh-var(--navbar-height)-var(--safe-bottom))]'
    );
    expect(airdropsSource).toContain('<PageHeader title="Airdrop" />');
    expect(airdropsSource).toContain('<RouteExitFooter');

    const distributionSource = readFileSync(
      join(
        process.cwd(),
        'src/pages/apps/airdrops/screens/AirdropDistributionScreen.tsx'
      ),
      'utf8'
    );
    expect(distributionSource).toContain(
      'className="wallet-btn-secondary w-full mt-2"'
    );
    expect(distributionSource).toContain("onClick={() => setStep('asset')}");
    expect(distributionSource).toContain('Previous step');
  });
});
