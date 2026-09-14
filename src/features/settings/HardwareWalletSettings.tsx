import React, { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  selectHardwareWallet,
  setHardwareWalletType,
  setHardwareWalletConnected,
  setDerivationPath,
  setLedgerTransport,
  disconnectHardwareWallet,
  UNSET_DERIVATION_PATH,
  type HardwareWalletType,
  type LedgerTransport,
} from '../../state/slices/hardwareWalletSlice';
import { selectCurrentNetwork } from '../../state/selectors/networkSelectors';
import { selectWalletDerivationPath } from '../../state/slices/walletSlice';
import { getBchAccountPath } from '../../services/HdWalletService';
import { trezorGetPublicKey } from '../../services/hardware/TrezorService';
import {
  ledgerGetPublicKey,
  ledgerDisconnect,
  setLedgerTransportType,
} from '../../services/hardware/LedgerService';
import { oneKeyGetPublicKey } from '../../services/hardware/OneKeyService';
import { unsupportedReason } from '../../services/hardware/hardwareTransportSupport';
import {
  canUseNativeHw,
  hwEnumerate,
  type HwDeviceInfo,
} from '../../services/hardware/nativeHw';
import { isDesktopPlatform } from '../../utils/platform';
import { useI18n } from '../../i18n/useI18n';
import type { TranslationKey } from '../../i18n/resources';

type ConnectStatus = 'idle' | 'connecting' | 'connected' | 'error';

const DEVICES: {
  type: HardwareWalletType;
  label: string;
  subtitle: string;
  connectionType: 'usb-bridge' | 'usb-ble' | 'qr' | 'nfc' | 'software';
  sdkNote: string;
  steps: string[];
  /** Not wired to a real signing path yet — selectable in the UI but cannot
   * connect or sign. See docs/keystone-hardware-wallet-scope.md. */
  disabled?: boolean;
}[] = [
  {
    type: 'none',
    label: 'Software Wallet',
    subtitle: 'Encrypted keys stored on this device',
    connectionType: 'software',
    sdkNote: '',
    steps: [],
  },
  {
    type: 'trezor',
    label: 'Trezor',
    subtitle: 'Desktop: native USB HID (Trezor One). Browser: not yet wired',
    connectionType: 'usb-bridge',
    sdkNote: 'Desktop: @trezor/protobuf + hidapi · Browser: @trezor/transport',
    steps: [
      'Desktop app: plug in Trezor One over USB (Model T/Safe WebUSB coming later)',
      'Unlock with PIN on the device',
      'Browser: being rebuilt on @trezor/transport WebUSB — use the desktop app for now',
    ],
  },
  {
    type: 'ledger',
    label: 'Ledger',
    subtitle: 'Desktop: native USB (like Ledger Live). Browser: WebHID',
    connectionType: 'usb-ble',
    sdkNote: 'Desktop: hidapi + @ledgerhq/hw-app-btc · Browser: webhid/web-ble',
    steps: [
      'Plug in over USB → enter PIN → open the Bitcoin Cash app',
      'Desktop uses native USB (no browser device picker)',
      'Browser build uses WebHID (Chrome device picker)',
    ],
  },
  {
    type: 'onekey',
    label: 'OneKey',
    subtitle:
      'Desktop: native USB (Trezor-compatible). Browser: OneKey web SDK',
    connectionType: 'usb-bridge',
    sdkNote: 'Desktop: same protobuf stack as Trezor + hidapi',
    steps: [
      'Plug in OneKey Pro / classic over USB and unlock',
      'Desktop talks USB natively (no OneKey Bridge required)',
      'Browser build still uses @onekeyfe/hd-web-sdk',
    ],
  },
  {
    type: 'keystone',
    label: 'Keystone',
    subtitle: 'Air-gapped QR signing — not yet supported',
    connectionType: 'qr',
    sdkNote: '@keystonehq/sdk + bc-ur-registry-btc',
    steps: [],
    disabled: true,
  },
  {
    type: 'tangem',
    label: 'Tangem',
    subtitle: 'Tap-to-sign card — phone only, not yet supported',
    connectionType: 'nfc',
    // Both JavaScript bridges are archived (tangem-sdk-react-native and
    // tangem-sdk-cordova, last pushed 2025-07-23; the Cordova package on npm
    // has not been published since 2023). The supported route is a native
    // plugin over their Swift and Kotlin SDKs.
    sdkNote: 'tangem-sdk-ios (Swift) · tangem-sdk-android (Kotlin) — native only',
    steps: [],
    disabled: true,
  },
];

export const HardwareWalletSettings: React.FC = () => {
  const dispatch = useDispatch();
  const { t } = useI18n();
  const hw = useSelector(selectHardwareWallet);
  const currentNetwork = useSelector(selectCurrentNetwork);
  const walletDerivationPath = useSelector(selectWalletDerivationPath);
  const defaultPath = walletDerivationPath || getBchAccountPath(currentNetwork);

  const [status, setStatus] = useState<ConnectStatus>(
    hw.connected ? 'connected' : 'idle'
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // A stored path still equal to the sentinel means the user never chose one,
  // so fall back to the wallet's path rather than showing a mainnet literal on
  // chipnet. Imported from the slice, never recomputed — an equal-looking
  // expression here would silently stop matching if either side moved.
  const [pathInput, setPathInput] = useState(() => {
    const persistedPath = hw.derivationPath;
    return persistedPath && persistedPath !== UNSET_DERIVATION_PATH
      ? persistedPath
      : defaultPath;
  });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [usbDevices, setUsbDevices] = useState<HwDeviceInfo[] | null>(null);
  const [usbScanNote, setUsbScanNote] = useState<string | null>(null);
  const desktopNative = isDesktopPlatform() && canUseNativeHw();

  useEffect(() => {
    setPathInput((path) =>
      path === UNSET_DERIVATION_PATH ? defaultPath : path
    );
  }, [defaultPath]);

  const selected = DEVICES.find((d) => d.type === hw.type) ?? DEVICES[0];
  const selectedLabel =
    selected.type === 'none' ? t('hardware.softwareLabel') : selected.label;
  const localizedDevice = (device: (typeof DEVICES)[number]) => {
    const subtitleKey: TranslationKey =
      device.type === 'none'
        ? 'hardware.softwareSubtitle'
        : device.type === 'trezor'
          ? 'hardware.trezorSubtitle'
          : device.type === 'ledger'
            ? 'hardware.ledgerSubtitle'
            : device.type === 'onekey'
              ? 'hardware.onekeySubtitle'
              : 'hardware.keystoneSubtitle';
    const stepKeys: TranslationKey[] =
      device.type === 'trezor'
        ? [
            'hardware.trezorStep1',
            'hardware.trezorStep2',
            'hardware.trezorStep3',
            'hardware.trezorStep4',
          ]
        : device.type === 'ledger'
          ? [
              'hardware.ledgerStep1',
              'hardware.ledgerStep2',
              'hardware.ledgerStep3',
            ]
          : device.type === 'onekey'
            ? [
                'hardware.onekeyStep1',
                'hardware.onekeyStep2',
                'hardware.onekeyStep3',
                'hardware.onekeyStep4',
              ]
            : [];
    return {
      ...device,
      label:
        device.type === 'none' ? t('hardware.softwareLabel') : device.label,
      subtitle: t(subtitleKey),
      steps: stepKeys.map((key) => t(key)),
    };
  };

  const handleTypeSelect = (type: HardwareWalletType) => {
    if (type === hw.type) return;
    if (DEVICES.find((d) => d.type === type)?.disabled) return;
    dispatch(setHardwareWalletType(type));
    setStatus('idle');
    setErrorMsg(null);
  };

  const handleUsbScan = async () => {
    setUsbScanNote(null);
    setUsbDevices(null);
    if (!desktopNative) {
      setUsbScanNote(
        'USB scan is only available in the desktop app (native HID).'
      );
      return;
    }
    try {
      const list = await hwEnumerate();
      setUsbDevices(list);
      if (list.length === 0) {
        setUsbScanNote(
          'No hardware wallets seen over USB HID. Plug in, unlock, and open the coin app (Bitcoin Cash on Ledger).'
        );
      } else {
        setUsbScanNote(`Found ${list.length} USB interface(s).`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setUsbScanNote(
        msg.includes('not allowed') || msg.includes('Command')
          ? 'Native USB commands are missing — fully restart the desktop app (tauri:dev rebuild) so hidapi is loaded.'
          : msg
      );
    }
  };

  const formatConnectError = (raw: string): string => {
    const m = raw.toLowerCase();
    if (
      m.includes('0x6e00') ||
      m.includes('cla_not_supported') ||
      m.includes('ins_not_supported')
    ) {
      return `${raw}\n\nOpen the Bitcoin Cash app on the Ledger (not Bitcoin) and leave it on the app home.`;
    }
    if (m.includes('0x6982') || m.includes('locked')) {
      return `${raw}\n\nUnlock the Ledger with your PIN, then open Bitcoin Cash.`;
    }
    if (m.includes('timed out') || m.includes('timeout')) {
      return `${raw}\n\nConfirm any prompt on the device, or reopen the Bitcoin Cash app and try again.`;
    }
    if (m.includes('no ledger') || m.includes('not found')) {
      return `${raw}\n\nWindows sees a Nano X when it is plugged in — use Scan USB, then Connect with BCH app open.`;
    }
    if (m.includes('command') && m.includes('not found')) {
      return `${raw}\n\nFully quit and restart the desktop app so native USB (hidapi) is compiled in.`;
    }
    return raw;
  };

  const handleConnect = async () => {
    if (selected.disabled) {
      setErrorMsg(t('hardware.notSupported', { device: selectedLabel }));
      setStatus('error');
      return;
    }
    // Block only when this runtime has no path (native USB or browser APIs).
    const blocked = unsupportedReason(hw.type);
    if (blocked) {
      setErrorMsg(blocked);
      setStatus('error');
      return;
    }

    setStatus('connecting');
    setErrorMsg(null);
    try {
      const path = pathInput.trim() || defaultPath;
      dispatch(setDerivationPath(path));

      if (hw.type === 'trezor') {
        const result = await trezorGetPublicKey(path);
        dispatch(
          setHardwareWalletConnected({
            connected: true,
            xpub: result.xpub,
            label: result.label,
          })
        );
        setStatus('connected');
      } else if (hw.type === 'ledger') {
        // Desktop always uses native USB; ignore stale BLE selection for connect.
        setLedgerTransportType(
          desktopNative ? 'usb' : hw.ledgerTransport ?? 'usb'
        );
        const ledgerPath = path.replace(/^m\//, '');
        const result = await ledgerGetPublicKey(ledgerPath);
        const xpub = result.publicKey + result.chainCode;
        dispatch(
          setHardwareWalletConnected({
            connected: true,
            xpub,
            label: result.label,
          })
        );
        setStatus('connected');
      } else if (hw.type === 'onekey') {
        const result = await oneKeyGetPublicKey(path);
        dispatch(
          setHardwareWalletConnected({
            connected: true,
            xpub: result.xpub,
            label: result.label,
          })
        );
        setStatus('connected');
      }
      // 'keystone' has no real signing path yet (see docs/keystone-hardware-wallet-scope.md)
      // and is caught by the `selected.disabled` guard above before reaching here.
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(formatConnectError(msg));
      setStatus('error');
    }
  };

  const handleDisconnect = async () => {
    if (hw.type === 'ledger') {
      try {
        await ledgerDisconnect();
      } catch {
        /* ignore */
      }
    }
    dispatch(disconnectHardwareWallet());
    setStatus('idle');
    setErrorMsg(null);
  };

  const isConnecting = status === 'connecting';

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="space-y-1">
        <h2
          className="text-lg font-semibold"
          style={{ color: 'var(--wallet-text-primary)' }}
        >
          {t('hardware.title')}
        </h2>
        <p
          className="text-sm"
          style={{ color: 'var(--wallet-text-secondary)' }}
        >
          {t('hardware.description')}
        </p>
      </div>

      {/* Device selection list */}
      <div className="space-y-2">
        {DEVICES.map((device) => {
          const localized = localizedDevice(device);
          const isSelected = hw.type === device.type;
          return (
            <button
              key={device.type}
              onClick={() => handleTypeSelect(device.type)}
              disabled={device.disabled}
              className="w-full text-left rounded-lg px-3 py-2.5 transition-colors"
              style={{
                background: isSelected
                  ? 'var(--wallet-primary-bg, rgba(99,102,241,0.12))'
                  : 'var(--wallet-surface-2)',
                border: `1px solid ${isSelected ? 'var(--wallet-primary, #6366f1)' : 'var(--wallet-border)'}`,
                opacity: device.disabled ? 0.5 : 1,
                cursor: device.disabled ? 'not-allowed' : 'pointer',
              }}
            >
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-1.5">
                    <p
                      className="text-sm font-medium"
                      style={{ color: 'var(--wallet-text-primary)' }}
                    >
                      {localized.label}
                    </p>
                    {device.disabled && (
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded"
                        style={{
                          background: 'var(--wallet-border)',
                          color: 'var(--wallet-text-secondary)',
                        }}
                      >
                        {t('hardware.comingSoon')}
                      </span>
                    )}
                  </div>
                  <p
                    className="text-xs"
                    style={{ color: 'var(--wallet-text-secondary)' }}
                  >
                    {localized.subtitle}
                  </p>
                </div>
                <div
                  className="w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0"
                  style={{
                    borderColor: isSelected
                      ? 'var(--wallet-primary, #6366f1)'
                      : 'var(--wallet-border)',
                    background: isSelected
                      ? 'var(--wallet-primary, #6366f1)'
                      : 'transparent',
                  }}
                >
                  {isSelected && (
                    <div
                      className="w-1.5 h-1.5 rounded-full"
                      style={{ background: 'white' }}
                    />
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Connected status */}
      {status === 'connected' && hw.connected && (
        <div
          className="rounded-lg p-3 space-y-2"
          style={{
            background: 'var(--wallet-success-bg, rgba(34,197,94,0.1))',
            border: '1px solid var(--wallet-success, #22c55e)',
          }}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span style={{ color: 'var(--wallet-success, #22c55e)' }}>●</span>
              <span
                className="text-sm font-medium"
                style={{ color: 'var(--wallet-text-primary)' }}
              >
                {hw.deviceLabel ?? selectedLabel} {t('hardware.active')}
              </span>
              {hw.type === 'keystone' && (
                <span
                  className="text-xs px-1.5 py-0.5 rounded"
                  style={{
                    background: 'var(--wallet-surface-2)',
                    color: 'var(--wallet-text-secondary)',
                  }}
                >
                  {t('hardware.airGap')}
                </span>
              )}
            </div>
            <button
              className="text-xs wallet-btn-danger px-2 py-1"
              onClick={handleDisconnect}
            >
              {t('hardware.disconnect')}
            </button>
          </div>
          {hw.xpub && hw.type !== 'keystone' && (
            <p
              className="text-xs font-mono break-all"
              style={{ color: 'var(--wallet-text-secondary)' }}
            >
              {hw.xpub.slice(0, 24)}…{hw.xpub.slice(-8)}
            </p>
          )}
          <p
            className="text-xs"
            style={{ color: 'var(--wallet-text-secondary)' }}
          >
            {t('hardware.path')}: {hw.derivationPath}
          </p>
          <p
            className="text-xs"
            style={{ color: 'var(--wallet-text-secondary)' }}
          >
            Connected ≠ wallet open. Go to the wallet list →{' '}
            <strong>Connect Hardware Wallet</strong> →{' '}
            <strong>Open wallet from this device</strong> to get Home / Receive
            / Send.
          </p>
        </div>
      )}

      {/* Setup section — shown when a hardware device is selected and not yet connected */}
      {hw.type !== 'none' && !hw.connected && selected.disabled && (
        <div
          className="rounded-lg p-3 text-sm"
          style={{
            background: 'var(--wallet-surface-2)',
            border: '1px solid var(--wallet-border)',
            color: 'var(--wallet-text-secondary)',
          }}
        >
          {t('hardware.notSupported', { device: selectedLabel })}
        </div>
      )}
      {hw.type !== 'none' && !hw.connected && !selected.disabled && (
        <div className="space-y-3">
          {selected.steps.length > 0 && (
            <div
              className="rounded-lg p-3 text-sm space-y-1.5"
              style={{
                background: 'var(--wallet-surface-2)',
                border: '1px solid var(--wallet-border)',
              }}
            >
              <p
                className="font-medium"
                style={{ color: 'var(--wallet-text-primary)' }}
              >
                {t('hardware.beforeConnecting')}
              </p>
              <ol
                className="list-decimal list-inside space-y-1"
                style={{ color: 'var(--wallet-text-secondary)' }}
              >
                {localizedDevice(selected).steps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
              {selected.sdkNote && (
                <p
                  className="text-xs pt-1"
                  style={{
                    color: 'var(--wallet-text-secondary)',
                    opacity: 0.7,
                  }}
                >
                  SDK: {selected.sdkNote}
                </p>
              )}
            </div>
          )}

          {/* Ledger: transport selector (BLE only meaningful in browser) */}
          {hw.type === 'ledger' && (
            <div className="space-y-1.5">
              <p
                className="text-xs font-medium"
                style={{ color: 'var(--wallet-text-secondary)' }}
              >
                {t('hardware.connectionType')}
              </p>
              <div className="flex gap-2">
                {(['usb', 'ble'] as LedgerTransport[]).map((t) => (
                  <button
                    key={t}
                    onClick={() => dispatch(setLedgerTransport(t))}
                    disabled={desktopNative && t === 'ble'}
                    className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium ${
                      (hw.ledgerTransport ?? 'usb') === t
                        ? 'wallet-btn-primary'
                        : 'wallet-btn-secondary'
                    }`}
                  >
                    {t === 'usb'
                      ? desktopNative
                        ? 'USB (native)'
                        : 'USB (WebHID)'
                      : 'Bluetooth (browser only)'}
                  </button>
                ))}
              </div>
              {desktopNative && (
                <p
                  className="text-xs"
                  style={{ color: 'var(--wallet-text-secondary)' }}
                >
                  Desktop uses native USB like Ledger Live. Keep the{' '}
                  <strong>Bitcoin Cash</strong> app open on the device (you
                  already have this right).
                </p>
              )}
            </div>
          )}

          {desktopNative && (
            <div className="space-y-2">
              <button
                type="button"
                className="wallet-btn-secondary w-full text-sm"
                onClick={() => void handleUsbScan()}
              >
                Scan USB devices
              </button>
              {usbScanNote && (
                <p
                  className="text-xs whitespace-pre-wrap"
                  style={{ color: 'var(--wallet-text-secondary)' }}
                >
                  {usbScanNote}
                </p>
              )}
              {usbDevices && usbDevices.length > 0 && (
                <ul
                  className="text-xs space-y-1 font-mono"
                  style={{ color: 'var(--wallet-text-secondary)' }}
                >
                  {usbDevices.map((d) => (
                    <li key={d.path}>
                      {d.family}: {d.product ?? 'device'} (vid=
                      {d.vendor_id.toString(16)} pid={d.product_id.toString(16)}
                      )
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Advanced: derivation path */}
          {hw.type !== 'keystone' && (
            <div>
              <button
                className="text-xs"
                style={{ color: 'var(--wallet-text-secondary)' }}
                onClick={() => setShowAdvanced((v) => !v)}
              >
                {showAdvanced ? '▲' : '▼'} {t('hardware.advanced')}
              </button>
              {showAdvanced && (
                <div className="mt-2 space-y-1">
                  <label
                    className="text-xs"
                    style={{ color: 'var(--wallet-text-secondary)' }}
                  >
                    {t('hardware.bip44Path')}
                  </label>
                  <input
                    type="text"
                    className="wallet-input w-full text-sm font-mono"
                    value={pathInput}
                    onChange={(e) => setPathInput(e.target.value)}
                    placeholder={defaultPath}
                  />
                </div>
              )}
            </div>
          )}

          <button
            className="wallet-btn-primary w-full"
            onClick={handleConnect}
            disabled={isConnecting}
          >
            {isConnecting
              ? t('hardware.connecting')
              : hw.type === 'keystone'
                ? t('hardware.enableKeystone')
                : t('hardware.connect', { device: selectedLabel })}
          </button>
        </div>
      )}

      {/* Error */}
      {status === 'error' && errorMsg && (
        <div
          className="rounded-lg p-3 text-sm"
          style={{
            background: 'var(--wallet-danger-bg, rgba(239,68,68,0.1))',
            border: '1px solid var(--wallet-danger, #ef4444)',
            color: 'var(--wallet-danger, #ef4444)',
          }}
        >
          {errorMsg}
        </div>
      )}

      {/* How it works */}
      <div
        className="rounded-lg p-3 text-xs"
        style={{
          background: 'var(--wallet-surface-2)',
          border: '1px solid var(--wallet-border)',
        }}
      >
        <p
          className="font-medium mb-1"
          style={{ color: 'var(--wallet-text-primary)' }}
        >
          {t('hardware.howItWorks')}
        </p>
        {hw.type === 'keystone' ? (
          <p style={{ color: 'var(--wallet-text-secondary)' }}>
            {t('hardware.keystoneHow')}
          </p>
        ) : (
          <p style={{ color: 'var(--wallet-text-secondary)' }}>
            {t('hardware.softwareHow')}
          </p>
        )}
      </div>
    </div>
  );
};
