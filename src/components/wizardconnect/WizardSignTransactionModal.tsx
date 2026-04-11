import { useDispatch, useSelector } from 'react-redux';
import { binToHex, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import type { AppDispatch, RootState } from '../../redux/store';
import { approveWizardSignRequest, rejectWizardSignRequest } from '../../redux/wizardconnectSlice';
import { ensureUint8Array, parseSatoshis } from '../../utils/binary';
import { SATSINBITCOIN } from '../../utils/constants';

type TxAmountCarrier = { valueSatoshis: unknown };
type TxToken = {
  category: unknown;
  amount?: unknown;
  nft?: { capability?: string; commitment?: unknown };
};
type TxOutput = TxAmountCarrier & {
  lockingBytecode: unknown;
  token?: TxToken;
};
type TxInputSource = TxAmountCarrier & {
  outpointTransactionHash: unknown;
  outpointIndex: number;
};

function parsePushData(bytecode: Uint8Array): string[] {
  const result: string[] = [];
  let i = 1;

  while (i < bytecode.length) {
    const len = bytecode[i];
    i += 1;
    const chunk = bytecode.slice(i, i + len);
    const hex = binToHex(chunk);
    const ascii = new TextDecoder('utf-8', { fatal: false }).decode(chunk);
    result.push(`${ascii} (0x${hex})`);
    i += len;
  }

  return result;
}

export default function WizardSignTransactionModal() {
  const dispatch = useDispatch<AppDispatch>();
  const pending = useSelector((state: RootState) => state.wizardconnect.pendingSignRequest);
  const connections = useSelector((state: RootState) => state.wizardconnect.activeConnections);

  if (!pending) return null;

  const connection = connections[pending.connectionId];
  const payload = pending.request.transaction;
  const tx =
    payload.transaction && typeof payload.transaction === 'object'
      ? payload.transaction
      : null;
  const sourceOutputs = payload.sourceOutputs ?? [];
  const outputs = tx?.outputs ?? [];
  const totalInput = (sourceOutputs as TxInputSource[]).reduce(
    (sum, output) => sum + parseSatoshis(output.valueSatoshis),
    0n
  );
  const totalOutput = (outputs as TxOutput[]).reduce(
    (sum, output) => sum + parseSatoshis(output.valueSatoshis),
    0n
  );

  const handleApprove = async () => {
    await dispatch(approveWizardSignRequest());
  };

  const handleReject = async () => {
    await dispatch(rejectWizardSignRequest());
  };

  return (
    <div className="wallet-popup-backdrop">
      <div className="wallet-popup-panel max-w-2xl w-full flex flex-col space-y-4">
        <h3 className="text-xl font-bold text-center">WizardConnect Sign Request</h3>

        <div className="overflow-y-auto max-h-[60vh] space-y-4 pr-1">
          <div className="text-sm wallet-muted">
            <div>
              <strong>DApp:</strong> {connection?.dappName ?? connection?.label ?? 'Unknown dApp'}
            </div>
            <div>
              <strong>Status:</strong> {connection?.status.status ?? 'pending'}
            </div>
          </div>

          {payload.userPrompt && (
            <p className="text-sm wallet-surface-strong border border-[var(--wallet-border)] rounded p-2 wallet-text-strong">
              <strong>Prompt:</strong> {payload.userPrompt}
            </p>
          )}

          {!tx && (
            <div className="text-sm wallet-surface-strong border border-[var(--wallet-border)] rounded p-3 wallet-text-strong">
              This request uses an unsupported transaction representation in the current OPTN Wallet integration.
            </div>
          )}

          {tx && (
            <>
              {(sourceOutputs as TxInputSource[]).map((source, index) => (
                <div key={`${pending.request.sequence}-${index}`} className="ml-2">
                  <div>
                    TXID:{' '}
                    <span className="font-mono break-all">
                      {binToHex(ensureUint8Array(source.outpointTransactionHash))}
                    </span>
                  </div>
                  <div>Index: {source.outpointIndex}</div>
                  <div>{Number(parseSatoshis(source.valueSatoshis)) / SATSINBITCOIN} BCH</div>
                </div>
              ))}

              {(outputs as TxOutput[]).map((output, index) => {
                const value = parseSatoshis(output.valueSatoshis);
                const lockingBytecode = ensureUint8Array(output.lockingBytecode);
                const isOpReturn = lockingBytecode[0] === 0x6a;

                if (isOpReturn) {
                  const parsed = parsePushData(lockingBytecode);
                  return (
                    <div
                      key={`${pending.request.sequence}-output-${index}`}
                      className="ml-2 space-y-1 border-b border-[var(--wallet-border)] pb-2 text-sm"
                    >
                      <strong>OP_RETURN Output</strong>
                      {parsed.map((line, lineIndex) => (
                        <div
                          key={`${pending.request.sequence}-output-${index}-line-${lineIndex}`}
                          className="font-mono wallet-muted break-words"
                        >
                          {line}
                        </div>
                      ))}
                    </div>
                  );
                }

                const addressResult = lockingBytecodeToCashAddress({
                  prefix: 'bitcoincash',
                  bytecode: lockingBytecode,
                });
                const address = typeof addressResult === 'string' ? addressResult : addressResult.address;

                return (
                  <div
                    key={`${pending.request.sequence}-standard-output-${index}`}
                    className="ml-2 border-b border-[var(--wallet-border)] pb-2 space-y-1"
                  >
                    <div>
                      Address:{' '}
                      <span className="font-mono wallet-link break-all">{address}</span>
                    </div>
                    <div>{Number(value) / SATSINBITCOIN} BCH</div>
                    {output.token && (
                      <div className="text-sm wallet-surface-strong border border-[var(--wallet-border)] rounded p-2 space-y-1">
                        <div>
                          <strong>Token Category:</strong>{' '}
                          <span className="font-mono break-all">
                            {binToHex(ensureUint8Array(output.token.category))}
                          </span>
                        </div>
                        {output.token.amount && (
                          <div>
                            <strong>Fungible Amount:</strong> {parseSatoshis(output.token.amount).toString()}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              <div className="text-sm border-t border-[var(--wallet-border)] pt-2">
                <div>Total Input: {Number(totalInput) / SATSINBITCOIN} BCH</div>
                <div>Total Output: {Number(totalOutput) / SATSINBITCOIN} BCH</div>
                <div className="font-semibold">
                  Estimated Fee: {Number(totalInput - totalOutput) / SATSINBITCOIN} BCH
                </div>
                <div>Broadcast: {payload.broadcast ? 'Yes' : 'No'}</div>
              </div>
            </>
          )}
        </div>

        <div className="flex justify-around pt-2">
          <button onClick={() => void handleApprove()} className="wallet-btn-primary">
            Sign
          </button>
          <button onClick={() => void handleReject()} className="wallet-btn-danger">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
