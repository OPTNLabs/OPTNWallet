/** @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  navigate: vi.fn(),
  generateMnemonic: vi
    .fn()
    .mockResolvedValue(
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    ),
  ensureFreshConnection: vi.fn().mockResolvedValue(undefined),
  startDatabase: vi.fn().mockResolvedValue(true),
}));

vi.mock('@capacitor/toast', () => ({
  Toast: { show: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('react-redux', () => ({
  useDispatch: () => mocks.dispatch,
  useSelector: (selector: (state: unknown) => unknown) =>
    selector({
      wallet_id: { currentWalletId: 0, networkType: 'mainnet' },
      network: { currentNetwork: 'mainnet' },
    }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    locale: 'en',
    t: (key: string) =>
      ({
        'onboarding.createWallet': 'Create Wallet',
        'onboarding.welcomeAlt': 'OPTN Wallet',
        'onboarding.generatedMnemonic': 'Generated recovery phrase',
        'onboarding.mnemonicWarning':
          'Your recovery phrase is the master key to your wallet.',
        'onboarding.seedInstruction':
          'Write these 12 words down in order and keep them somewhere safe. Anyone with this phrase can spend your funds — never share it or store it digitally.',
        'onboarding.creating': 'Creating Wallet…',
        'onboarding.back': 'Back',
        'onboarding.generatingSeed': 'Generating seed phrase…',
        'derivation.walletNetwork': 'Wallet network',
        'derivation.walletNetworkDescription': 'Choose the network.',
        'derivation.addressDerivation': 'Address derivation',
        'derivation.addressDerivationDescription': 'Choose an address path.',
        'derivation.customize': 'Customize',
        'network.mainnet': 'Mainnet',
        'network.chipnet': 'Chipnet',
        'onboarding.helpNetworkDescription':
          'Select Mainnet for real funds or CHIPNET for test funds before you proceed.',
      })[key] ?? key,
  }),
}));

vi.mock('../../../apis/DatabaseManager/DatabaseService', () => ({
  default: () => ({ startDatabase: mocks.startDatabase }),
}));

vi.mock('../../../apis/WalletManager/WalletManager', () => ({
  default: () => ({
    checkAccount: vi.fn(),
    createWallet: vi.fn(),
    setWalletId: vi.fn(),
    getWalletInfo: vi.fn(),
  }),
}));

vi.mock('../../../services/KeyService', () => ({
  default: {
    generateMnemonic: mocks.generateMnemonic,
    bootstrapInitialAddressBatch: vi.fn(),
  },
}));

vi.mock('../../../apis/ElectrumServer/ElectrumServer', () => ({
  default: () => ({ ensureFreshConnection: mocks.ensureFreshConnection }),
}));

import CreateWalletPage from '../CreateWalletPage';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CreateWalletPage', () => {
  it('keeps recovery safety guidance visible beside the generated phrase', async () => {
    render(<CreateWalletPage />);

    expect(await screen.findByTestId('recovery-safety-note')).toHaveTextContent(
      'Anyone with this phrase can spend your funds'
    );
    expect(screen.getByRole('note')).toHaveTextContent(
      'never share it or store it digitally'
    );
  });
});
