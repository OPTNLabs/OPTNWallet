import { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import {
  selectExplorerCustom,
  selectExplorerId,
  selectChainPolicy,
  setChainPolicy,
  setExplorerCustom,
  setExplorerId,
} from '../../state/slices/preferencesSlice';
import { getExplorerPresets } from '../../utils/servers/explorers';
import { useI18n } from '../../i18n/useI18n';
import { isDesktopPlatform } from '../../utils/platform';

export function ExplorerSettings() {
  const dispatch = useDispatch();
  const { t } = useI18n();
  const explorerId = useSelector(selectExplorerId);
  const explorerCustom = useSelector(selectExplorerCustom);
  const chainPolicy = useSelector(selectChainPolicy);
  const desktop = isDesktopPlatform();
  const [customTx, setCustomTx] = useState(explorerCustom.tx);
  const [customAddress, setCustomAddress] = useState(explorerCustom.address);

  useEffect(() => {
    setCustomTx(explorerCustom.tx);
    setCustomAddress(explorerCustom.address);
  }, [explorerCustom.address, explorerCustom.tx]);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold wallet-text-strong">
          {t('server.blockExplorer')}
        </h2>
        <p className="mt-1 text-sm wallet-muted">
          Choose which explorer opens from transaction details. The selected
          network determines whether the mainnet or Chipnet URL is used.
        </p>
      </div>

      {!desktop ? (
        <div className="space-y-2 rounded-xl border border-[var(--wallet-border)] p-3">
          <h3 className="text-sm font-semibold wallet-text-strong">
            {t('server.explorerAccess')}
          </h3>
          <p className="text-xs wallet-muted">
            {t('server.explorerAccessDescription')}
          </p>
          <label className="block text-sm wallet-text-strong">
            <span className="sr-only">{t('server.explorerAccess')}</span>
            <select
              value={
                chainPolicy === 'own_infrastructure' ||
                chainPolicy === 'privacy'
                  ? 'own_infrastructure'
                  : 'auto'
              }
              onChange={(event) => dispatch(setChainPolicy(event.target.value))}
              className="min-h-[44px] w-full rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] px-3 py-2 text-sm wallet-text-strong outline-none focus:ring-1 focus:ring-[var(--wallet-accent)]"
            >
              <option value="auto">{t('server.allowPublicExplorers')}</option>
              <option value="own_infrastructure">
                {t('server.privateExplorerOnly')}
              </option>
            </select>
          </label>
        </div>
      ) : null}

      <label className="block text-sm wallet-text-strong">
        <span className="sr-only">{t('server.blockExplorer')}</span>
        <select
          value={explorerId}
          onChange={(event) => dispatch(setExplorerId(event.target.value))}
          className="min-h-[44px] w-full rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] px-3 py-2 text-sm wallet-text-strong outline-none focus:ring-1 focus:ring-[var(--wallet-accent)]"
        >
          {getExplorerPresets().map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
          <option value="custom">{t('server.custom')}</option>
        </select>
      </label>

      {explorerId === 'custom' ? (
        <div className="space-y-3 rounded-xl border border-[var(--wallet-border)] p-3">
          <label className="block text-xs font-semibold wallet-text-strong">
            Transaction URL template
            <input
              type="text"
              value={customTx}
              onChange={(event) => setCustomTx(event.target.value)}
              placeholder={t('server.txUrlPlaceholder')}
              className="mt-1 min-h-[44px] w-full rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] px-3 py-2 text-xs font-mono wallet-text-strong placeholder:wallet-muted outline-none focus:ring-1 focus:ring-[var(--wallet-accent)]"
            />
          </label>
          <label className="block text-xs font-semibold wallet-text-strong">
            Address URL template
            <input
              type="text"
              value={customAddress}
              onChange={(event) => setCustomAddress(event.target.value)}
              placeholder={t('server.addressUrlPlaceholder')}
              className="mt-1 min-h-[44px] w-full rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] px-3 py-2 text-xs font-mono wallet-text-strong placeholder:wallet-muted outline-none focus:ring-1 focus:ring-[var(--wallet-accent)]"
            />
          </label>
          <p className="text-xs wallet-muted">{t('server.placeholderHelp')}</p>
          <button
            type="button"
            onClick={() =>
              dispatch(
                setExplorerCustom({ tx: customTx, address: customAddress })
              )
            }
            disabled={!customTx.includes('{txid}')}
            className="wallet-btn-secondary min-h-[44px] px-3 py-2 text-sm disabled:opacity-40"
          >
            {t('server.saveCustom')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default ExplorerSettings;
