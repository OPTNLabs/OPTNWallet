// Desktop-only wallet creation flow, matching Electron Cash's shape:
//   generate seed -> re-type it to confirm you captured it -> confirm the
//   derivation path -> name this wallet and set ITS OWN password -> done.
// Replaces src/features/onboarding/CreateWalletPage.tsx via a Vite alias
// (desktop builds only); the upstream mobile page is untouched.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import DatabaseService from '../../../apis/DatabaseManager/DatabaseService';
import KeyService from '../../../services/KeyService';
import { normalizeBchAccountPath } from '../../../services/HdWalletService';
import { Network, setNetwork } from '../../../state/slices/networkSlice';
import { selectCurrentNetwork } from '../../../state/selectors/networkSelectors';
import {
  setWalletId,
  setWalletNetwork,
  setWalletType,
  setWalletDerivationPath,
} from '../../../state/slices/walletSlice';
import { WalletType } from '../../../types/wallet';
import OnboardingCard from '../../../features/onboarding/components/OnboardingCard';
import OnboardingScreen from '../../../features/onboarding/components/OnboardingScreen';
import DerivationPathField from '../../../features/onboarding/components/DerivationPathField';
import { createWalletWithPassword } from '../DesktopWalletManager';
import { validateNewWalletPassword } from '../passwordPolicy';
import { defaultDesktopAccountPath } from '../desktopDerivationDefaults';
import { useI18n } from '../../../i18n/useI18n';
import { getBip39LanguageForLocale } from '../../../services/Bip39Service';

type Step = 'loading' | 'reveal' | 'confirm' | 'path' | 'name';

const CONFIRM_WORD_COUNT = 3;

function pickConfirmIndices(total: number, count: number): number[] {
  const indices = new Set<number>();
  while (indices.size < Math.min(count, total)) {
    indices.add(Math.floor(Math.random() * total));
  }
  return Array.from(indices).sort((a, b) => a - b);
}

const DesktopCreateWalletPage = () => {
  const [step, setStep] = useState<Step>('loading');
  const [mnemonic, setMnemonic] = useState('');
  const [confirmIndices, setConfirmIndices] = useState<number[]>([]);
  const [confirmInputs, setConfirmInputs] = useState<Record<number, string>>(
    {}
  );
  const [confirmError, setConfirmError] = useState('');

  const [walletName, setWalletName] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [nameError, setNameError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const dbService = useMemo(() => DatabaseService(), []);
  const hasInitialized = useRef(false);
  const navigate = useNavigate();
  const currentNetwork = useSelector(selectCurrentNetwork);
  const dispatch = useDispatch();
  const { locale, t } = useI18n();
  const [derivationPath, setDerivationPath] = useState(() =>
    defaultDesktopAccountPath(currentNetwork)
  );
  const [customDerivationPath, setCustomDerivationPath] = useState(false);

  useEffect(() => {
    dispatch(setNetwork(Network.MAINNET));
  }, [dispatch]);

  useEffect(() => {
    if (!customDerivationPath)
      setDerivationPath(defaultDesktopAccountPath(currentNetwork));
  }, [currentNetwork, customDerivationPath]);

  useEffect(() => {
    if (hasInitialized.current) return;
    hasInitialized.current = true;

    void (async () => {
      try {
        const dbStarted = await dbService.startDatabase();
        if (!dbStarted) throw new Error('Failed to start the database.');
        const generated = await KeyService.generateMnemonic(
          getBip39LanguageForLocale(locale)
        );
        setMnemonic(generated);
        setStep('reveal');
      } catch (error) {
        console.error(
          '[DesktopCreateWalletPage] Error generating wallet:',
          error
        );
      }
    })();
  }, [dbService, locale]);

  const mnemonicWords = mnemonic ? mnemonic.split(' ') : [];
  const halfLength = Math.ceil(mnemonicWords.length / 2);

  const handleRevealContinue = () => {
    setConfirmIndices(
      pickConfirmIndices(mnemonicWords.length, CONFIRM_WORD_COUNT)
    );
    setConfirmInputs({});
    setConfirmError('');
    setStep('confirm');
  };

  const handleConfirmSubmit = () => {
    const allMatch = confirmIndices.every(
      (i) => (confirmInputs[i] ?? '').trim().toLowerCase() === mnemonicWords[i]
    );
    if (!allMatch) {
      setConfirmError(t('onboarding.confirmError'));
      return;
    }
    setConfirmError('');
    setStep('path');
  };

  const handleCreate = async () => {
    if (!walletName.trim()) {
      setNameError(t('onboarding.nameRequired'));
      return;
    }
    const passErr = validateNewWalletPassword(password, passwordConfirm);
    if (passErr) {
      setNameError(
        password !== passwordConfirm
          ? t('onboarding.passwordMismatch')
          : passErr
      );
      return;
    }
    setNameError('');
    setIsSubmitting(true);
    try {
      const normalizedDerivationPath = normalizeBchAccountPath(derivationPath);
      const walletId = await createWalletWithPassword({
        name: walletName.trim(),
        mnemonic,
        passphrase: '',
        network: currentNetwork,
        walletType: WalletType.STANDARD,
        derivationPath: normalizedDerivationPath,
        derivationPathSource: customDerivationPath ? 'custom' : 'default',
        password,
      });
      if (walletId == null) {
        setNameError(t('onboarding.walletAlreadyExists'));
        return;
      }

      // Materialize the same initial receive/change window used by desktop
      // network switching before opening Settings or Home.
      await KeyService.bootstrapInitialAddressBatch(walletId, 0, 20);

      dispatch(setWalletId(walletId));
      dispatch(setWalletNetwork(currentNetwork));
      dispatch(setWalletType(WalletType.STANDARD));
      dispatch(
        setWalletDerivationPath({
          path: normalizedDerivationPath,
          source: customDerivationPath ? 'custom' : 'default',
        })
      );
      dispatch(setNetwork(currentNetwork));
      window.dispatchEvent(new CustomEvent('optn:wallets-changed'));
      navigate(`/home/${walletId}`);
    } catch (error) {
      console.error('[DesktopCreateWalletPage] Error creating wallet:', error);
      setNameError(t('onboarding.creationFailed'));
    } finally {
      setIsSubmitting(false);
    }
  };

  if (step === 'loading') {
    return (
      <OnboardingScreen>
        <OnboardingCard title={t('onboarding.createWallet')}>
          <div className="text-center wallet-text-strong py-12">
            {t('onboarding.generatingSeed')}
          </div>
        </OnboardingCard>
      </OnboardingScreen>
    );
  }

  if (step === 'reveal') {
    return (
      <OnboardingScreen>
        <OnboardingCard title={t('onboarding.seedTitle')}>
          <p className="text-sm wallet-muted text-center mb-3">
            {t('onboarding.seedInstruction')}
          </p>
          <div className="grid grid-cols-2 gap-4 mb-4 p-3 rounded-xl wallet-surface-strong border border-[var(--wallet-border)]">
            <div>
              {mnemonicWords.slice(0, halfLength).map((word, index) => (
                <div key={index} className="flex items-center mb-2">
                  <span className="w-8 wallet-text-strong font-semibold">
                    {index + 1}.
                  </span>
                  <span className="wallet-text-strong font-semibold">
                    {word}
                  </span>
                </div>
              ))}
            </div>
            <div>
              {mnemonicWords.slice(halfLength).map((word, index) => (
                <div
                  key={index + halfLength}
                  className="flex items-center mb-2"
                >
                  <span className="w-8 wallet-text-strong font-semibold">
                    {index + halfLength + 1}.
                  </span>
                  <span className="wallet-text-strong font-semibold">
                    {word}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <button
            onClick={handleRevealContinue}
            className="wallet-btn-primary w-full my-2 text-xl font-bold"
          >
            {t('onboarding.wroteItDown')}
          </button>
          <button
            onClick={() => navigate('/')}
            className="wallet-btn-danger w-full my-2 text-xl font-bold"
          >
            {t('onboarding.back')}
          </button>
        </OnboardingCard>
      </OnboardingScreen>
    );
  }

  if (step === 'confirm') {
    return (
      <OnboardingScreen>
        <OnboardingCard title={t('onboarding.confirmSeed')}>
          <p className="text-sm wallet-muted text-center mb-3">
            {t('onboarding.confirmInstruction')}
          </p>
          <div className="space-y-3 mb-4 p-3 rounded-xl wallet-surface-strong border border-[var(--wallet-border)]">
            {confirmIndices.map((i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-16 shrink-0 wallet-text-strong font-semibold">
                  {t('onboarding.word')} {i + 1}
                </span>
                <input
                  type="text"
                  autoCapitalize="none"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  value={confirmInputs[i] ?? ''}
                  onChange={(e) => {
                    setConfirmInputs((prev) => ({
                      ...prev,
                      [i]: e.target.value,
                    }));
                    setConfirmError('');
                  }}
                  className="wallet-input flex-1 px-3 py-2 rounded-md wallet-text-strong"
                />
              </div>
            ))}
          </div>
          {confirmError && (
            <p className="text-sm text-red-400 text-center mb-2">
              {confirmError}
            </p>
          )}
          <button
            onClick={handleConfirmSubmit}
            className="wallet-btn-primary w-full my-2 text-xl font-bold"
          >
            {t('onboarding.confirm')}
          </button>
          <button
            onClick={() => setStep('reveal')}
            className="wallet-btn-secondary w-full my-2 text-lg"
          >
            {t('onboarding.back')}
          </button>
        </OnboardingCard>
      </OnboardingScreen>
    );
  }

  if (step === 'path') {
    return (
      <OnboardingScreen>
        <OnboardingCard title={t('onboarding.walletSetup')}>
          <p className="text-sm wallet-muted text-center mb-3">
            {t('onboarding.walletSetupDescription')}
          </p>
          <DerivationPathField
            network={currentNetwork}
            value={derivationPath}
            custom={customDerivationPath}
            onChange={(path, custom) => {
              setDerivationPath(path);
              setCustomDerivationPath(custom);
            }}
          />
          <button
            onClick={() => setStep('name')}
            className="wallet-btn-primary w-full my-2 text-xl font-bold"
          >
            {t('onboarding.continue')}
          </button>
        </OnboardingCard>
      </OnboardingScreen>
    );
  }

  // step === 'name'
  return (
    <OnboardingScreen>
      <OnboardingCard title={t('onboarding.nameWallet')}>
        <p className="text-sm wallet-muted text-center mb-3">
          {t('onboarding.nameWalletDescription')}
        </p>
        <div className="space-y-3 mb-2">
          <input
            type="text"
            value={walletName}
            onChange={(e) => {
              setWalletName(e.target.value);
              setNameError('');
            }}
            placeholder={t('onboarding.walletNamePlaceholder')}
            autoFocus
            className="wallet-input w-full px-3 py-2 rounded-md wallet-text-strong"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setNameError('');
            }}
            placeholder={t('onboarding.passwordPlaceholder')}
            autoComplete="new-password"
            className="wallet-input w-full px-3 py-2 rounded-md wallet-text-strong"
          />
          <input
            type="password"
            value={passwordConfirm}
            onChange={(e) => {
              setPasswordConfirm(e.target.value);
              setNameError('');
            }}
            placeholder={t('onboarding.confirmPasswordPlaceholder')}
            autoComplete="new-password"
            className="wallet-input w-full px-3 py-2 rounded-md wallet-text-strong"
          />
        </div>
        {nameError && (
          <p className="text-sm text-red-400 text-center mb-2">{nameError}</p>
        )}
        <button
          onClick={() => void handleCreate()}
          disabled={isSubmitting}
          className="wallet-btn-primary w-full my-2 text-xl font-bold"
        >
          {t('onboarding.createWallet')}
        </button>
      </OnboardingCard>
    </OnboardingScreen>
  );
};

export default DesktopCreateWalletPage;
