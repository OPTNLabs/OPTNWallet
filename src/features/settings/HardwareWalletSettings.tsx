import React, { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  selectHardwareWallet,
  setHardwareWalletType,
  setHardwareWalletConnected,
  setDerivationPath,
  setLedgerTransport,
  disconnectHardwareWallet,
  type HardwareWalletType,
  type LedgerTransport,
} from '../../state/slices/hardwareWalletSlice';
import { selectCurrentNetwork } from '../../state/selectors/networkSelectors';
import { Network } from '../../state/slices/networkSlice';
import { getBchAccountPath } from '../../services/HdWalletService';
import { trezorGetPublicKey } from '../../services/hardware/TrezorService';
import { ledgerGetPublicKey, ledgerDisconnect, setLedgerTransportType } from '../../services/hardware/LedgerService';
import { oneKeyGetPublicKey } from '../../services/hardware/OneKeyService';

type ConnectStatus = 'idle' | 'connecting' | 'connected' | 'error';

const DEVICES: {
  type: HardwareWalletType;
  label: string;
  subtitle: string;
  connectionType: 'usb-bridge' | 'usb-ble' | 'qr' | 'software';
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
    subtitle: 'USB or Bluetooth via Trezor Bridge',
    connectionType: 'usb-bridge',
    sdkNote: 'Trezor Connect v9 (connect.trezor.io/9)',
    steps: [
      'Install Trezor Suite — it includes the Bridge daemon',
      'Plug in your Trezor (USB) or pair via Bluetooth (newer models)',
      'Unlock your device with your PIN',
      'Allow the connection popup when it appears',
    ],
  },
  {
    type: 'ledger',
    label: 'Ledger',
    subtitle: 'USB (WebHID) or Bluetooth (Nano X)',
    connectionType: 'usb-ble',
    sdkNote: 'hw-transport-webhid / hw-transport-web-ble + hw-app-btc',
    steps: [
      'USB: plug in → enter PIN → open Bitcoin Cash app',
      'Bluetooth (Nano X): enable BLE on device → open Bitcoin Cash app',
      'The browser will show a device picker prompt',
    ],
  },
  {
    type: 'onekey',
    label: 'OneKey',
    subtitle: 'USB or Bluetooth via OneKey Bridge',
    connectionType: 'usb-bridge',
    sdkNote: '@onekeyfe/hd-web-sdk (developer.onekey.so)',
    steps: [
      'Install OneKey Bridge if not already installed',
      'Plug in your OneKey device or pair via Bluetooth',
      'Unlock your device with your PIN',
      'Allow the connection when requested',
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
];

export const HardwareWalletSettings: React.FC = () => {
  const dispatch = useDispatch();
  const hw = useSelector(selectHardwareWallet);
  const currentNetwork = useSelector(selectCurrentNetwork);
  const defaultPath = getBchAccountPath(currentNetwork);

  const [status, setStatus] = useState<ConnectStatus>(hw.connected ? 'connected' : 'idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState(() => {
    const persistedPath = hw.derivationPath;
    const legacyMainnetDefault = getBchAccountPath(Network.MAINNET);
    return persistedPath && persistedPath !== legacyMainnetDefault
      ? persistedPath
      : defaultPath;
  });
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    const legacyMainnetDefault = getBchAccountPath(Network.MAINNET);
    setPathInput((path) => (path === legacyMainnetDefault ? defaultPath : path));
  }, [defaultPath]);

  const selected = DEVICES.find((d) => d.type === hw.type) ?? DEVICES[0];

  const handleTypeSelect = (type: HardwareWalletType) => {
    if (type === hw.type) return;
    if (DEVICES.find((d) => d.type === type)?.disabled) return;
    dispatch(setHardwareWalletType(type));
    setStatus('idle');
    setErrorMsg(null);
  };

  const handleConnect = async () => {
    if (selected.disabled) {
      setErrorMsg(`${selected.label} is not yet supported.`);
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
        dispatch(setHardwareWalletConnected({ connected: true, xpub: result.xpub, label: result.label }));
        setStatus('connected');
      } else if (hw.type === 'ledger') {
        setLedgerTransportType(hw.ledgerTransport ?? 'usb');
        const ledgerPath = path.replace(/^m\//, '');
        const result = await ledgerGetPublicKey(ledgerPath);
        const xpub = result.publicKey + result.chainCode;
        dispatch(setHardwareWalletConnected({ connected: true, xpub, label: result.label }));
        setStatus('connected');
      } else if (hw.type === 'onekey') {
        const result = await oneKeyGetPublicKey(path);
        dispatch(setHardwareWalletConnected({ connected: true, xpub: result.xpub, label: result.label }));
        setStatus('connected');
      }
      // 'keystone' has no real signing path yet (see docs/keystone-hardware-wallet-scope.md)
      // and is caught by the `selected.disabled` guard above before reaching here.
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(msg);
      setStatus('error');
    }
  };

  const handleDisconnect = async () => {
    if (hw.type === 'ledger') {
      try { await ledgerDisconnect(); } catch { /* ignore */ }
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
        <h2 className="text-lg font-semibold" style={{ color: 'var(--wallet-text-primary)' }}>
          Hardware Wallet
        </h2>
        <p className="text-sm" style={{ color: 'var(--wallet-text-secondary)' }}>
          The device holds your private keys. The wallet is the bridge. Keys never leave the hardware.
        </p>
      </div>

      {/* Device selection list */}
      <div className="space-y-2">
        {DEVICES.map((device) => {
          const isSelected = hw.type === device.type;
          return (
            <button
              key={device.type}
              onClick={() => handleTypeSelect(device.type)}
              disabled={device.disabled}
              className="w-full text-left rounded-lg px-3 py-2.5 transition-colors"
              style={{
                background: isSelected ? 'var(--wallet-primary-bg, rgba(99,102,241,0.12))' : 'var(--wallet-surface-2)',
                border: `1px solid ${isSelected ? 'var(--wallet-primary, #6366f1)' : 'var(--wallet-border)'}`,
                opacity: device.disabled ? 0.5 : 1,
                cursor: device.disabled ? 'not-allowed' : 'pointer',
              }}
            >
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-1.5">
                    <p className="text-sm font-medium" style={{ color: 'var(--wallet-text-primary)' }}>
                      {device.label}
                    </p>
                    {device.disabled && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--wallet-border)', color: 'var(--wallet-text-secondary)' }}>
                        Coming soon
                      </span>
                    )}
                  </div>
                  <p className="text-xs" style={{ color: 'var(--wallet-text-secondary)' }}>
                    {device.subtitle}
                  </p>
                </div>
                <div
                  className="w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0"
                  style={{
                    borderColor: isSelected ? 'var(--wallet-primary, #6366f1)' : 'var(--wallet-border)',
                    background: isSelected ? 'var(--wallet-primary, #6366f1)' : 'transparent',
                  }}
                >
                  {isSelected && (
                    <div className="w-1.5 h-1.5 rounded-full" style={{ background: 'white' }} />
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
          style={{ background: 'var(--wallet-success-bg, rgba(34,197,94,0.1))', border: '1px solid var(--wallet-success, #22c55e)' }}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span style={{ color: 'var(--wallet-success, #22c55e)' }}>●</span>
              <span className="text-sm font-medium" style={{ color: 'var(--wallet-text-primary)' }}>
                {hw.deviceLabel ?? selected.label} active
              </span>
              {hw.type === 'keystone' && (
                <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--wallet-surface-2)', color: 'var(--wallet-text-secondary)' }}>
                  air-gap
                </span>
              )}
            </div>
            <button className="text-xs wallet-btn-danger px-2 py-1" onClick={handleDisconnect}>
              Disconnect
            </button>
          </div>
          {hw.xpub && hw.type !== 'keystone' && (
            <p className="text-xs font-mono break-all" style={{ color: 'var(--wallet-text-secondary)' }}>
              {hw.xpub.slice(0, 24)}…{hw.xpub.slice(-8)}
            </p>
          )}
          <p className="text-xs" style={{ color: 'var(--wallet-text-secondary)' }}>
            Path: {hw.derivationPath}
          </p>
        </div>
      )}

      {/* Setup section — shown when a hardware device is selected and not yet connected */}
      {hw.type !== 'none' && !hw.connected && selected.disabled && (
        <div
          className="rounded-lg p-3 text-sm"
          style={{ background: 'var(--wallet-surface-2)', border: '1px solid var(--wallet-border)', color: 'var(--wallet-text-secondary)' }}
        >
          {selected.label} support isn't finished yet — it can't connect or sign in this build. Pick another device, or use the software wallet.
        </div>
      )}
      {hw.type !== 'none' && !hw.connected && !selected.disabled && (
        <div className="space-y-3">
          {selected.steps.length > 0 && (
            <div className="rounded-lg p-3 text-sm space-y-1.5" style={{ background: 'var(--wallet-surface-2)', border: '1px solid var(--wallet-border)' }}>
              <p className="font-medium" style={{ color: 'var(--wallet-text-primary)' }}>
                Before connecting
              </p>
              <ol className="list-decimal list-inside space-y-1" style={{ color: 'var(--wallet-text-secondary)' }}>
                {selected.steps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
              {selected.sdkNote && (
                <p className="text-xs pt-1" style={{ color: 'var(--wallet-text-secondary)', opacity: 0.7 }}>
                  SDK: {selected.sdkNote}
                </p>
              )}
            </div>
          )}

          {/* Ledger: transport selector */}
          {hw.type === 'ledger' && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium" style={{ color: 'var(--wallet-text-secondary)' }}>
                Connection type
              </p>
              <div className="flex gap-2">
                {(['usb', 'ble'] as LedgerTransport[]).map((t) => (
                  <button
                    key={t}
                    onClick={() => dispatch(setLedgerTransport(t))}
                    className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium ${
                      (hw.ledgerTransport ?? 'usb') === t ? 'wallet-btn-primary' : 'wallet-btn-secondary'
                    }`}
                  >
                    {t === 'usb' ? 'USB (WebHID)' : 'Bluetooth (Nano X)'}
                  </button>
                ))}
              </div>
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
                {showAdvanced ? '▲' : '▼'} Advanced (derivation path)
              </button>
              {showAdvanced && (
                <div className="mt-2 space-y-1">
                  <label className="text-xs" style={{ color: 'var(--wallet-text-secondary)' }}>
                    BIP44 path
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
              ? 'Connecting…'
              : hw.type === 'keystone'
                ? 'Enable Keystone (QR mode)'
                : `Connect ${selected.label}`}
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
      <div className="rounded-lg p-3 text-xs" style={{ background: 'var(--wallet-surface-2)', border: '1px solid var(--wallet-border)' }}>
        <p className="font-medium mb-1" style={{ color: 'var(--wallet-text-primary)' }}>How it works</p>
        {hw.type === 'keystone' ? (
          <p style={{ color: 'var(--wallet-text-secondary)' }}>
            Keystone's air-gapped QR signing isn't finished yet — the app can't build or read the QR codes it would need to in this build. Support is planned but not ready for real funds.
          </p>
        ) : (
          <p style={{ color: 'var(--wallet-text-secondary)' }}>
            Your private keys never leave the device. The wallet builds an unsigned transaction, the device shows the details on its screen, you physically confirm, and the device sends back only the signature. Like Electron Cash's hardware wallet mode.
          </p>
        )}
      </div>
    </div>
  );
};
