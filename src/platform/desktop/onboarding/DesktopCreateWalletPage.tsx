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
import { getBchCoinType } from '../../../services/HdWalletService';
import { setNetwork } from '../../../state/slices/networkSlice';
import { selectCurrentNetwork } from '../../../state/selectors/networkSelectors';
import { setWalletId, setWalletNetwork, setWalletType } from '../../../state/slices/walletSlice';
import { WalletType } from '../../../types/wallet';
import OnboardingCard from '../../../features/onboarding/components/OnboardingCard';
import OnboardingScreen from '../../../features/onboarding/components/OnboardingScreen';
import NetworkSelector from '../../../features/onboarding/components/NetworkSelector';
import { createWalletWithPassword } from '../DesktopWalletManager';

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
  const [confirmInputs, setConfirmInputs] = useState<Record<number, string>>({});
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

  useEffect(() => {
    if (hasInitialized.current) return;
    hasInitialized.current = true;

    void (async () => {
      try {
        const dbStarted = await dbService.startDatabase();
        if (!dbStarted) throw new Error('Failed to start the database.');
        const generated = await KeyService.generateMnemonic();
        setMnemonic(generated);
        setStep('reveal');
      } catch (error) {
        console.error('[DesktopCreateWalletPage] Error generating wallet:', error);
      }
    })();
  }, [dbService]);

  const mnemonicWords = mnemonic ? mnemonic.split(' ') : [];
  const halfLength = Math.ceil(mnemonicWords.length / 2);

  const handleRevealContinue = () => {
    setConfirmIndices(pickConfirmIndices(mnemonicWords.length, CONFIRM_WORD_COUNT));
    setConfirmInputs({});
    setConfirmError('');
    setStep('confirm');
  };

  const handleConfirmSubmit = () => {
    const allMatch = confirmIndices.every(
      (i) => (confirmInputs[i] ?? '').trim().toLowerCase() === mnemonicWords[i]
    );
    if (!allMatch) {
      setConfirmError("Those don't match your seed phrase. Check the words and try again.");
      return;
    }
    setConfirmError('');
    setStep('path');
  };

  const handleCreate = async () => {
    if (!walletName.trim()) {
      setNameError('Give this wallet a name.');
      return;
    }
    if (password !== passwordConfirm) {
      setNameError('Passwords do not match.');
      return;
    }
    setNameError('');
    setIsSubmitting(true);
    try {
      const walletId = await createWalletWithPassword({
        name: walletName.trim(),
        mnemonic,
        passphrase: '',
        network: currentNetwork,
        walletType: WalletType.STANDARD,
        password,
      });
      if (walletId == null) {
        setNameError('Could not create this wallet. It may already exist.');
        return;
      }

      void KeyService.bootstrapInitialAddressBatch(walletId, 0, 10).catch((error) => {
        console.error('[DesktopCreateWalletPage] Failed to bootstrap initial addresses:', error);
      });

      dispatch(setWalletId(walletId));
      dispatch(setWalletNetwork(currentNetwork));
      dispatch(setWalletType(WalletType.STANDARD));
      dispatch(setNetwork(currentNetwork));
      window.dispatchEvent(new CustomEvent('optn:wallets-changed'));
      navigate(`/home/${walletId}`);
    } catch (error) {
      console.error('[DesktopCreateWalletPage] Error creating wallet:', error);
      setNameError('Wallet creation failed. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const derivationPath = `m/44'/${getBchCoinType(currentNetwork)}'/0'`;

  if (step === 'loading') {
    return (
      <OnboardingScreen>
        <OnboardingCard title="Create Wallet">
          <div className="text-center wallet-text-strong py-12">Generating seed phrase…</div>
        </OnboardingCard>
      </OnboardingScreen>
    );
  }

  if (step === 'reveal') {
    return (
      <OnboardingScreen>
        <OnboardingCard title="Your Seed Phrase">
          <NetworkSelector networkType={currentNetwork} />
          <p className="text-sm wallet-muted text-center mb-3">
            Write these 12 words down in order and keep them somewhere safe. Anyone with this
            phrase can spend your funds — never share it or store it digitally.
          </p>
          <div className="grid grid-cols-2 gap-4 mb-4 p-3 rounded-xl wallet-surface-strong border border-[var(--wallet-border)]">
            <div>
              {mnemonicWords.slice(0, halfLength).map((word, index) => (
                <div key={index} className="flex items-center mb-2">
                  <span className="w-8 wallet-text-strong font-semibold">{index + 1}.</span>
                  <span className="wallet-text-strong font-semibold">{word}</span>
                </div>
              ))}
            </div>
            <div>
              {mnemonicWords.slice(halfLength).map((word, index) => (
                <div key={index + halfLength} className="flex items-center mb-2">
                  <span className="w-8 wallet-text-strong font-semibold">
                    {index + halfLength + 1}.
                  </span>
                  <span className="wallet-text-strong font-semibold">{word}</span>
                </div>
              ))}
            </div>
          </div>
          <button onClick={handleRevealContinue} className="wallet-btn-primary w-full my-2 text-xl font-bold">
            I've written it down
          </button>
          <button onClick={() => navigate('/')} className="wallet-btn-danger w-full my-2 text-xl font-bold">
            Back
          </button>
        </OnboardingCard>
      </OnboardingScreen>
    );
  }

  if (step === 'confirm') {
    return (
      <OnboardingScreen>
        <OnboardingCard title="Confirm Your Seed Phrase">
          <p className="text-sm wallet-muted text-center mb-3">
            Type the requested words to prove you saved them correctly.
          </p>
          <div className="space-y-3 mb-4 p-3 rounded-xl wallet-surface-strong border border-[var(--wallet-border)]">
            {confirmIndices.map((i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-16 shrink-0 wallet-text-strong font-semibold">Word {i + 1}</span>
                <input
                  type="text"
                  autoCapitalize="none"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  value={confirmInputs[i] ?? ''}
                  onChange={(e) => {
                    setConfirmInputs((prev) => ({ ...prev, [i]: e.target.value }));
                    setConfirmError('');
                  }}
                  className="wallet-input flex-1 px-3 py-2 rounded-md wallet-text-strong"
                />
              </div>
            ))}
          </div>
          {confirmError && <p className="text-sm text-red-400 text-center mb-2">{confirmError}</p>}
          <button onClick={handleConfirmSubmit} className="wallet-btn-primary w-full my-2 text-xl font-bold">
            Confirm
          </button>
          <button onClick={() => setStep('reveal')} className="wallet-btn-secondary w-full my-2 text-lg">
            Back to seed phrase
          </button>
        </OnboardingCard>
      </OnboardingScreen>
    );
  }

  if (step === 'path') {
    return (
      <OnboardingScreen>
        <OnboardingCard title="Derivation Path">
          <p className="text-sm wallet-muted text-center mb-3">
            This wallet derives its addresses using the standard BIP44 path for Bitcoin Cash.
          </p>
          <div className="mb-4 p-4 rounded-xl wallet-surface-strong border border-[var(--wallet-border)] text-center">
            <code className="text-lg wallet-text-strong font-mono">{derivationPath}</code>
          </div>
          <button onClick={() => setStep('name')} className="wallet-btn-primary w-full my-2 text-xl font-bold">
            Continue
          </button>
        </OnboardingCard>
      </OnboardingScreen>
    );
  }

  // step === 'name'
  return (
    <OnboardingScreen>
      <OnboardingCard title="Name This Wallet">
        <p className="text-sm wallet-muted text-center mb-3">
          Give this wallet a name and a password. Each wallet on this device has its own
          independent password — you can create more wallets later with different passwords.
        </p>
        <div className="space-y-3 mb-2">
          <input
            type="text"
            value={walletName}
            onChange={(e) => { setWalletName(e.target.value); setNameError(''); }}
            placeholder="Wallet name"
            autoFocus
            className="wallet-input w-full px-3 py-2 rounded-md wallet-text-strong"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => { setPassword(e.target.value); setNameError(''); }}
            placeholder="Password (or leave blank)"
            className="wallet-input w-full px-3 py-2 rounded-md wallet-text-strong"
          />
          <input
            type="password"
            value={passwordConfirm}
            onChange={(e) => { setPasswordConfirm(e.target.value); setNameError(''); }}
            placeholder="Confirm password"
            className="wallet-input w-full px-3 py-2 rounded-md wallet-text-strong"
          />
        </div>
        {nameError && <p className="text-sm text-red-400 text-center mb-2">{nameError}</p>}
        <button
          onClick={() => void handleCreate()}
          disabled={isSubmitting}
          className="wallet-btn-primary w-full my-2 text-xl font-bold"
        >
          {isSubmitting ? 'Creating Wallet…' : 'Create Wallet'}
        </button>
      </OnboardingCard>
    </OnboardingScreen>
  );
};

export default DesktopCreateWalletPage;
