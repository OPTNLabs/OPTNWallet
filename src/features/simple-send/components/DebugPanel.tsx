import {
  InputTableRow,
  OutputTableRow,
  ReviewState,
  SimpleSendInput,
} from '../types';
import { useI18n } from '../../../i18n/useI18n';

type DebugPanelProps = {
  review: ReviewState | null;
  selectedForTx: SimpleSendInput[];
  rawHexLen: number;
  inputsTableRows: InputTableRow[];
  outputsTableRows: OutputTableRow[];
};

export function DebugPanel({
  selectedForTx,
  review,
  rawHexLen,
  inputsTableRows,
  outputsTableRows,
}: DebugPanelProps) {
  const { t } = useI18n();
  return (
    <div className="p-4 wallet-card space-y-3">
      <div className="text-base font-extrabold wallet-text-strong">
        {t('send.debug')}
      </div>

      <div className="rounded-lg wallet-card">
        <div className="px-3 py-2 border-b border-[var(--wallet-border)]">
          <div className="text-sm font-bold wallet-text-strong">
            {t('send.selectedInputs')}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="wallet-surface-strong">
              <tr>
                <th className="text-left px-3 py-2">#</th>
                <th className="text-left px-3 py-2">{t('send.outpoint')}</th>
                <th className="text-left px-3 py-2">{t('send.address')}</th>
                <th className="text-right px-3 py-2">{t('send.sats')}</th>
                <th className="text-right px-3 py-2">{t('send.height')}</th>
                <th className="text-center px-3 py-2">
                  {t('send.tokenLabel')}
                </th>
                <th className="text-center px-3 py-2">{t('send.contract')}</th>
              </tr>
            </thead>
            <tbody>
              {selectedForTx.length === 0 ? (
                <tr>
                  <td
                    className="px-3 py-3 text-center wallet-muted"
                    colSpan={7}
                  >
                    {t('send.noInputs')}
                  </td>
                </tr>
              ) : (
                inputsTableRows.map((r) => (
                  <tr
                    key={r.outpoint}
                    className="border-t border-[var(--wallet-border)]"
                  >
                    <td className="px-3 py-2">{r.i}</td>
                    <td className="px-3 py-2 font-mono">{r.outpoint}</td>
                    <td className="px-3 py-2 font-mono">{r.address}</td>
                    <td className="px-3 py-2 text-right">{r.amount}</td>
                    <td className="px-3 py-2 text-right">{r.height}</td>
                    <td className="px-3 py-2 text-center">{r.token}</td>
                    <td className="px-3 py-2 text-center">{r.contract}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-lg wallet-card">
        <div className="px-3 py-2 border-b border-[var(--wallet-border)]">
          <div className="text-sm font-bold wallet-text-strong">
            {t('send.finalOutputs')}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="wallet-surface-strong">
              <tr>
                <th className="text-left px-3 py-2">#</th>
                <th className="text-left px-3 py-2">{t('send.type')}</th>
                <th className="text-left px-3 py-2">{t('send.recipient')}</th>
                <th className="text-right px-3 py-2">{t('send.sats')}</th>
                <th className="text-left px-3 py-2">{t('send.tokenLabel')}</th>
                <th className="text-left px-3 py-2">{t('send.details')}</th>
              </tr>
            </thead>
            <tbody>
              {outputsTableRows.length === 0 ? (
                <tr>
                  <td
                    className="px-3 py-3 text-center wallet-muted"
                    colSpan={6}
                  >
                    {t('send.noOutputs')}
                  </td>
                </tr>
              ) : (
                outputsTableRows.map((r) => (
                  <tr
                    key={r.i}
                    className="border-t border-[var(--wallet-border)]"
                  >
                    <td className="px-3 py-2">{r.i}</td>
                    <td className="px-3 py-2">{r.type}</td>
                    <td className="px-3 py-2 font-mono">{r.address}</td>
                    <td className="px-3 py-2 text-right">{r.amount}</td>
                    <td className="px-3 py-2">{r.token}</td>
                    <td className="px-3 py-2">{r.details}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-lg wallet-card">
        <div className="flex items-center justify-between px-3 py-2 border-[var(--wallet-border)] border-b">
          <div className="text-sm font-bold wallet-text-strong">
            {t('send.rawTransaction')}
          </div>
          <div className="text-xs wallet-muted">
            bytes: <span className="font-mono">{Math.ceil(rawHexLen / 2)}</span>
          </div>
        </div>
        <pre className="text-xs p-3 overflow-auto max-h-64 wallet-text-strong break-all">
          {review?.rawTx ?? t('send.noTxBuilt')}
        </pre>
      </div>
    </div>
  );
}
