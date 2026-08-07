/**
 * Electron Cash–style hardware wallet wizard (NOT watch-only / air-gap).
 *
 * Ledger = live USB keystore:
 *   scan → assert Bitcoin Cash app → export xPub via hw-app-btc → create type=hardware
 *   → password-protect open → Home
 *
 * Watch-only stays a separate flow (paste xPub / QR / SeedCash PSBT).
 */

import { useCallback, useState } from 'react';
import { useSelector } from 'react-redux';
import { Network } from '../../../state/slices/networkSlice';
import { selectCurrentNetwork } from '../../../state/selectors/networkSelectors';
import { getBchAccountPath } from '../../../services/HdWalletService';
import {
  canUseNativeHw,
  hwEnumerate,
  type HwDeviceInfo,
  type HwFamily,
} from '../../../services/hardware/nativeHw';
import {
  ledgerExportAccountXpub,
  ledgerGetOpenApp,
} from '../../../services/hardware/ledgerXpub';
import { setLedgerTransportType } from '../../../services/hardware/LedgerService';
import { trezorExportAccountXpub } from '../../../services/hardware/TrezorNativeSession';
import {
  bridgePing,
  bridgeEnumerate,
} from '../../../services/hardware/trezorBridge';
import {
  createHardwareWallet,
  findHardwareWalletByXpub,
  type HardwareDeviceKind,
} from './hardwareWallet';
import { protectHardwareWalletWithPassword } from '../DesktopWalletManager';

export type HardwareWizardResult = {
  walletId: number;
  created: boolean;
  name: string;
  network: Network;
  accountPath: string;
};

type Step = 'intro' | 'scan' | 'path' | 'working';

type Props = {
  onBack: () => void;
  onOpened: (result: HardwareWizardResult) => void | Promise<void>;
};

const FAMILY_LABEL: Record<HwFamily, string> = {
  ledger: 'Ledger',
  trezor: 'Trezor',
  onekey: 'OneKey',
  unknown: 'Device',
};

export function HardwareWalletWizard({ onBack, onOpened }: Props) {
  const currentNetwork = useSelector(selectCurrentNetwork);
  const network =
    currentNetwork === Network.CHIPNET ? Network.CHIPNET : Network.MAINNET;

  const [step, setStep] = useState<Step>('intro');
  const [devices, setDevices] = useState<HwDeviceInfo[]>([]);
  const [selected, setSelected] = useState<HwDeviceInfo | null>(null);
  const [accountPath, setAccountPath] = useState(() =>
    getBchAccountPath(network)
  );
  const [walletName, setWalletName] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [statusLine, setStatusLine] = useState('');
  const [appHint, setAppHint] = useState('');

  const runScan = useCallback(async () => {
    setError('');
    setAppHint('');
    setBusy(true);
    setStatusLine('Scanning USB…');
    try {
      if (!canUseNativeHw()) {
        throw new Error(
          'Native USB is only available in the desktop app. Fully restart OPTN if you just built hardware support.'
        );
      }
      const list = await hwEnumerate();
      // EC trezorlib: also WebUSB (Safe 5) + optional Bridge.
      try {
        const { trezorWebUsbEnumerate } = await import(
          '../../../services/hardware/nativeHw'
        );
        const web = await trezorWebUsbEnumerate();
        for (const w of web) {
          list.push({
            path: w.path,
            vendor_id: w.vendor_id,
            product_id: w.product_id,
            product: w.product ?? 'Trezor Safe / Model T (WebUSB)',
            manufacturer: w.manufacturer ?? 'SatoshiLabs',
            family: 'trezor',
            interface_number: 0,
            usage_page: 0,
          });
        }
      } catch {
        /* webusb optional until rebuilt */
      }
      const bridgeOk = await bridgePing();
      if (bridgeOk) {
        try {
          const bDevs = await bridgeEnumerate();
          for (const b of bDevs) {
            list.push({
              path: `bridge:${b.path}`,
              vendor_id: b.vendor || 0x1209,
              product_id: b.product || 0,
              product: 'Trezor (Bridge)',
              manufacturer: 'SatoshiLabs',
              family: 'trezor',
              interface_number: 0,
              usage_page: 0,
            });
          }
        } catch {
          /* bridge optional */
        }
      }
      const sorted = [...list].sort((a, b) => {
        const rank = (f: HwFamily) =>
          f === 'ledger' ? 0 : f === 'trezor' ? 1 : f === 'onekey' ? 2 : 3;
        return rank(a.family) - rank(b.family);
      });
      // Dedupe by path
      const seen = new Set<string>();
      const unique = sorted.filter((d) => {
        if (seen.has(d.path)) return false;
        seen.add(d.path);
        return true;
      });
      setDevices(unique);
      setSelected(
        unique.find((d) => d.family === 'ledger') ??
          unique.find((d) => d.family === 'trezor') ??
          unique[0] ??
          null
      );
      setStep('scan');
      if (unique.length === 0) {
        setError(
          'No hardware wallet found.\n\n' +
            'Trezor Safe 5 (Electron Cash / libusb WebUSB):\n' +
            '1. Unlock PIN on the Safe\n' +
            '2. Close Trezor Suite if open (it can hold USB exclusively)\n' +
            '3. Use a data USB-C cable, Scan again\n\n' +
            'Ledger: USB + Bitcoin Cash app open\n' +
            'Trezor One: classic USB HID'
        );
      } else if (unique.some((d) => d.family === 'ledger')) {
        try {
          setLedgerTransportType('usb');
          const app = await ledgerGetOpenApp();
          setAppHint(`Ledger app right now: “${app.name}” v${app.version}`);
        } catch {
          setAppHint(
            'Ledger seen on USB — open the Bitcoin Cash app before creating.'
          );
        }
      } else if (unique.some((d) => d.path.startsWith('webusb:'))) {
        setAppHint(
          'Trezor found via WebUSB/libusb (Electron Cash path). Unlock and continue.'
        );
      } else if (bridgeOk) {
        setAppHint(`Trezor Bridge online (v${bridgeOk.version}).`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep('scan');
    } finally {
      setBusy(false);
      setStatusLine('');
    }
  }, []);

  const goPath = () => {
    if (!selected) {
      setError('Select a device first.');
      return;
    }
    if (
      selected.family !== 'ledger' &&
      selected.family !== 'trezor' &&
      selected.family !== 'onekey'
    ) {
      setError('Unknown device family.');
      return;
    }
    setError('');
    setAccountPath(getBchAccountPath(network));
    const label = FAMILY_LABEL[selected.family];
    setWalletName(
      selected.product
        ? `${label} ${selected.product}`
        : `${label} ${network === Network.CHIPNET ? 'Chipnet' : 'Mainnet'}`
    );
    setStep('path');
  };

  const createAndOpen = async () => {
    if (!selected) return;
    if (password.length < 8) {
      setError('Choose a password (min 8 characters) to open this wallet later.');
      return;
    }
    if (password !== passwordConfirm) {
      setError('Passwords do not match.');
      return;
    }

    setBusy(true);
    setError('');
    setStep('working');
    try {
      const path = accountPath.trim() || getBchAccountPath(network);
      let xpub = '';
      let firstHint = '';
      let deviceKind: HardwareDeviceKind = 'ledger';
      let deviceLabel = FAMILY_LABEL[selected.family];

      if (selected.family === 'ledger') {
        setLedgerTransportType('usb');
        setStatusLine('Checking Bitcoin Cash app + exporting xPub (hw-app-btc)…');
        const exported = await ledgerExportAccountXpub(network, path);
        xpub = exported.xpub;
        firstHint = exported.firstAddress;
        deviceKind = 'ledger';
        deviceLabel = exported.app.name;
        setStatusLine(
          `OK — app “${exported.app.name}” · ${exported.firstAddress.slice(0, 18)}…`
        );
      } else if (
        selected.family === 'trezor' ||
        selected.family === 'onekey'
      ) {
        // Safe 5 / Model T: Trezor Bridge (Suite). Model One: HID fallback.
        setStatusLine(
          'Talking to Trezor via Bridge (Suite) or HID — confirm on device if asked…'
        );
        const net = network === Network.CHIPNET ? 'chipnet' : 'mainnet';
        const exported = await trezorExportAccountXpub(
          net,
          path,
          selected.family
        );
        xpub = exported.xpub;
        firstHint =
          exported.firstAddress ??
          exported.xpub.slice(0, 16);
        deviceKind = selected.family;
        deviceLabel = `Trezor via ${exported.via}`;
        setStatusLine(
          exported.firstAddress
            ? `OK — ${exported.via} · first receive …/0/0 · ${exported.firstAddress.slice(0, 22)}…`
            : `OK — xPub via ${exported.via}`
        );
      } else {
        throw new Error('Unsupported device');
      }

      const existingId = await findHardwareWalletByXpub(xpub);
      if (existingId != null) {
        setStatusLine('Opening existing hardware wallet…');
        await onOpened({
          walletId: existingId,
          created: false,
          name: walletName.trim() || deviceLabel,
          network,
          accountPath: path,
        });
        return;
      }

      setStatusLine('Creating hardware wallet (type=hardware, not watch-only)…');
      const name =
        walletName.trim() ||
        `${deviceKind} ${firstHint.replace(/^bitcoincash:|^bchtest:/, '').slice(0, 10)}…`;
      const walletId = await createHardwareWallet({
        name,
        accountXpub: xpub,
        network,
        accountPath: path,
        deviceKind,
        deviceLabel,
      });
      setStatusLine('Password-protecting wallet open…');
      await protectHardwareWalletWithPassword(walletId, password);

      await onOpened({
        walletId,
        created: true,
        name,
        network,
        accountPath: path,
      });
    } catch (err) {
      console.error('[HardwareWalletWizard]', err);
      setError(err instanceof Error ? err.message : String(err));
      setStep('path');
    } finally {
      setBusy(false);
      setStatusLine('');
    }
  };

  return (
    <section className="min-h-[100dvh] wallet-surface flex flex-col items-center px-4 py-10">
      <div className="w-full max-w-md space-y-4">
        <h1 className="text-xl font-bold wallet-text-strong text-center">
          Use a hardware device
        </h1>
        <p className="text-sm wallet-muted text-center">
          Electron Cash model: the Ledger becomes a <strong>hardware wallet</strong>{' '}
          (live USB signing). This is <strong>not</strong> watch-only / air-gap.
        </p>

        {step === 'intro' && (
          <div className="wallet-card p-4 space-y-3">
            <ol className="list-decimal list-inside text-sm space-y-2 wallet-text-strong">
              <li>Plug in Ledger and unlock with PIN</li>
              <li>
                Open the <strong>Bitcoin Cash</strong> app (we check the app name)
              </li>
              <li>Scan → pick device → path → password → Home</li>
            </ol>
            <p className="text-xs wallet-muted">
              Network:{' '}
              <strong>
                {network === Network.CHIPNET ? 'Chipnet' : 'Mainnet'}
              </strong>
            </p>
            <button
              type="button"
              className="wallet-btn-primary w-full py-3 font-bold"
              disabled={busy}
              onClick={() => void runScan()}
            >
              {busy ? 'Scanning…' : 'Scan for devices'}
            </button>
          </div>
        )}

        {step === 'scan' && (
          <div className="wallet-card p-4 space-y-3">
            <p className="text-sm font-semibold wallet-text-strong">
              Select a device
            </p>
            {appHint && (
              <p className="text-xs wallet-muted whitespace-pre-wrap">{appHint}</p>
            )}
            {devices.length === 0 ? (
              <p className="text-sm wallet-muted">No devices found.</p>
            ) : (
              <div className="space-y-2">
                {devices.map((d) => {
                  const active = selected?.path === d.path;
                  return (
                    <button
                      key={d.path}
                      type="button"
                      onClick={() => setSelected(d)}
                      className="w-full text-left rounded-lg px-3 py-2.5"
                      style={{
                        background: active
                          ? 'var(--wallet-primary-bg, rgba(99,102,241,0.12))'
                          : 'var(--wallet-surface-2)',
                        border: `1px solid ${
                          active
                            ? 'var(--wallet-primary, #6366f1)'
                            : 'var(--wallet-border)'
                        }`,
                      }}
                    >
                      <p className="text-sm font-medium wallet-text-strong">
                        {FAMILY_LABEL[d.family]}
                        {d.product ? ` · ${d.product}` : ''}
                      </p>
                      <p className="text-[10px] font-mono wallet-muted">
                        vid={d.vendor_id.toString(16)} pid=
                        {d.product_id.toString(16)}
                      </p>
                    </button>
                  );
                })}
              </div>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                className="wallet-btn-secondary flex-1 py-2"
                disabled={busy}
                onClick={() => void runScan()}
              >
                Rescan
              </button>
              <button
                type="button"
                className="wallet-btn-primary flex-1 py-2 font-semibold"
                disabled={busy || !selected}
                onClick={goPath}
              >
                Next
              </button>
            </div>
          </div>
        )}

        {step === 'path' && selected && (
          <div className="wallet-card p-4 space-y-3">
            <p className="text-sm font-semibold wallet-text-strong">
              Derivation, name &amp; password
            </p>
            <p className="text-xs wallet-muted">
              Mainnet account xPub path:{' '}
              <code className="font-mono">m/44&apos;/145&apos;/0&apos;</code>{' '}
              (purpose / BCH coin type / account). First receive address is{' '}
              <code className="font-mono">…/0/0</code> (external branch 0, index
              0). The “depth 3” check means that account xPub only — not path
              component 3.
            </p>
            <label className="block text-xs wallet-muted">Wallet name</label>
            <input
              className="wallet-input w-full px-3 py-2 text-sm"
              value={walletName}
              onChange={(e) => setWalletName(e.target.value)}
            />
            <label className="block text-xs wallet-muted">Account path</label>
            <input
              className="wallet-input w-full px-3 py-2 text-sm font-mono"
              value={accountPath}
              onChange={(e) => setAccountPath(e.target.value)}
            />
            <label className="block text-xs wallet-muted">
              Password (required to open this wallet)
            </label>
            <input
              type="password"
              autoComplete="new-password"
              className="wallet-input w-full px-3 py-2 text-sm"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Min 8 characters"
            />
            <input
              type="password"
              autoComplete="new-password"
              className="wallet-input w-full px-3 py-2 text-sm"
              value={passwordConfirm}
              onChange={(e) => setPasswordConfirm(e.target.value)}
              placeholder="Confirm password"
            />
            <div className="flex gap-2">
              <button
                type="button"
                className="wallet-btn-secondary flex-1 py-2"
                disabled={busy}
                onClick={() => setStep('scan')}
              >
                Back
              </button>
              <button
                type="button"
                className="wallet-btn-primary flex-1 py-2 font-semibold"
                disabled={busy}
                onClick={() => void createAndOpen()}
              >
                {busy ? 'Working…' : 'Create hardware wallet'}
              </button>
            </div>
          </div>
        )}

        {step === 'working' && (
          <div className="wallet-card p-4 space-y-2 text-center">
            <p className="text-sm wallet-text-strong">
              {statusLine || 'Working…'}
            </p>
          </div>
        )}

        {error && (
          <p className="text-xs text-red-400 whitespace-pre-wrap">{error}</p>
        )}

        <button
          type="button"
          onClick={onBack}
          className="wallet-btn-secondary w-full py-2 text-sm"
          disabled={busy && step === 'working'}
        >
          Back to wallets
        </button>
      </div>
    </section>
  );
}
