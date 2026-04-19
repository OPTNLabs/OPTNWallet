// inside src/components/walletconnect/SignTransactionModal.tsx

import { useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState, AppDispatch } from '../../redux/store';
import {
  respondWithTxSignature,
  clearPendingSignTx,
  respondWithTxError,
} from '../../redux/walletconnectSlice';
import { binToHex, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import { SATSINBITCOIN } from '../../utils/constants';
import { ensureUint8Array, parseSatoshis } from '../../utils/binary';
import { selectWalletId } from '../../redux/walletSlice';
import useOutboundTransactions from '../../hooks/useOutboundTransactions';
import { shortenAddress } from '../../utils/shortenHash';
import WalletTooltip from '../ui/WalletTooltip';
import { FiChevronDown, FiChevronUp } from 'react-icons/fi';

export function SignTransactionModal() {
  const dispatch = useDispatch<AppDispatch>();
  const walletId = useSelector(selectWalletId);
  const signTxRequest = useSelector(
    (state: RootState) => state.walletconnect.pendingSignTx
  );
  const activeSessions = useSelector(
    (state: RootState) => state.walletconnect.activeSessions
  );
  const { hasUnresolved } = useOutboundTransactions(walletId);

  const [inputsExpanded, setInputsExpanded] = useState(false);
  const [outputsExpanded, setOutputsExpanded] = useState(false);

  if (!signTxRequest) return null;

  const { topic, params } = signTxRequest;
  const { request } = params;
  const tx = request.params?.transaction;
  const sourceOutputs = request.params?.sourceOutputs ?? [];
  const userPrompt = request.params?.userPrompt ?? '';
  const shouldBroadcast = !!request.params?.broadcast;
  const dappMetadata = activeSessions?.[topic]?.peer?.metadata;
  const inputs = tx?.inputs || [];
  const outputs = tx?.outputs || [];

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
    let i = 1; // skip OP_RETURN
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

  function toCashAddress(
    bytecode: unknown,
    prefix: 'bitcoincash' | 'bchtest' | 'bchreg' = 'bitcoincash'
  ): string {
    try {
      const result = lockingBytecodeToCashAddress({
        prefix,
        bytecode: ensureUint8Array(bytecode),
      });
      return typeof result === 'string' ? `⚠️ ${result}` : result.address;
    } catch {
      return '⚠️ Invalid locking bytecode';
    }
  }

  const totalInput: bigint = (sourceOutputs as TxInputSource[]).reduce(
    (sum: bigint, o) => sum + parseSatoshis(o.valueSatoshis),
    0n
  );
  const totalOutput: bigint = (outputs as TxOutput[]).reduce(
    (sum: bigint, o) => sum + parseSatoshis(o.valueSatoshis),
    0n
  );
  const fee = totalInput - totalOutput;
  const broadcastLocked = shouldBroadcast && hasUnresolved;

  const handleSign = async () => {
    if (broadcastLocked) return;
    await dispatch(respondWithTxSignature(signTxRequest));
    dispatch(clearPendingSignTx());
  };

  const handleCancel = async () => {
    await dispatch(respondWithTxError(signTxRequest));
    dispatch(clearPendingSignTx());
  };

  return (
    <div className="wallet-popup-backdrop">
      <div className="wallet-popup-panel max-w-2xl w-full flex flex-col space-y-4">
        <h3 className="text-xl font-bold text-center">
          Sign Transaction Request
        </h3>

        <div className="overflow-y-auto max-h-[60vh] space-y-4 pr-1">
          {dappMetadata && (
            <div className="text-sm wallet-muted">
              <div>
                <strong>DApp Name:</strong> {dappMetadata.name}
              </div>
              <div>
                <strong>Domain:</strong>{' '}
                <a
                  href={dappMetadata.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="wallet-link underline"
                >
                  {dappMetadata.url}
                </a>
              </div>
            </div>
          )}

          {userPrompt && (
            <p className="text-sm wallet-surface-strong border border-[var(--wallet-border)] rounded p-2 wallet-text-strong">
              <strong>Prompt:</strong> {userPrompt}
            </p>
          )}

          {broadcastLocked && (
            <div className="text-sm wallet-surface-strong border border-[var(--wallet-border)] rounded p-3 wallet-text-strong">
              Another outgoing transaction is still syncing. To avoid duplicates
              while you are offline, this wallet will only broadcast one
              unresolved transaction at a time.
            </div>
          )}

          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setInputsExpanded(!inputsExpanded)}
              className="flex items-center gap-2 text-sm font-semibold wallet-text-strong"
            >
              {inputsExpanded ? <FiChevronUp /> : <FiChevronDown />}
              Inputs ({inputs.length})
            </button>
            {inputsExpanded && (
              <div className="space-y-1">
                {inputs.map((_, i: number) => {
                  const source = sourceOutputs[i];
                  const txid = binToHex(
                    ensureUint8Array(source.outpointTransactionHash)
                  );
                  const value = parseSatoshis(source.valueSatoshis);
                  return (
                    <div key={i} className="ml-2">
                      <div>
                        TXID:{' '}
                        <span className="font-mono break-all">{txid}</span>
                      </div>
                      <div>Index: {source.outpointIndex}</div>
                      <div>{Number(value) / SATSINBITCOIN} BCH</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setOutputsExpanded(!outputsExpanded)}
              className="flex items-center gap-2 text-sm font-semibold wallet-text-strong"
            >
              {outputsExpanded ? <FiChevronUp /> : <FiChevronDown />}
              Outputs ({outputs.length})
            </button>
            {outputsExpanded && (
              <div className="space-y-1">
                {(outputs as TxOutput[]).map((output, i: number) => {
                  const value = parseSatoshis(output.valueSatoshis);
                  const lockingBytecode = ensureUint8Array(
                    output.lockingBytecode
                  );
                  const isOpReturn = lockingBytecode[0] === 0x6a;
                  const token = output.token;

                  if (isOpReturn) {
                    const parsed = parsePushData(lockingBytecode);
                    return (
                      <div
                        key={i}
                        className="ml-2 space-y-1 border-b border-[var(--wallet-border)] pb-2 text-sm"
                      >
                        <strong>OP_RETURN Output</strong>
                        {parsed.map((data, j) => (
                          <div
                            key={j}
                            className="font-mono wallet-muted break-words"
                          >
                            {data}
                          </div>
                        ))}
                      </div>
                    );
                  }

                  const address = toCashAddress(lockingBytecode, 'bitcoincash');
                  return (
                    <div
                      key={i}
                      className="ml-2 border-b border-[var(--wallet-border)] pb-2 space-y-1"
                    >
                      <div>
                        Address:{' '}
                        <span
                          className="font-mono wallet-link break-all cursor-pointer"
                          data-tooltip-id={`address-tooltip-${i}`}
                          data-tooltip-content={address}
                        >
                          {shortenAddress(address)}
                        </span>
                        <WalletTooltip
                          id={`address-tooltip-${i}`}
                          place="top"
                          clickable={true}
                          content={address}
                        />
                      </div>
                      <div>{Number(value) / SATSINBITCOIN} BCH</div>
                      {token && (
                        <div className="text-sm wallet-surface-strong border border-[var(--wallet-border)] rounded p-2 space-y-1">
                          <div>
                            <strong>Token Category:</strong>{' '}
                            <span className="font-mono break-all">
                              {binToHex(ensureUint8Array(token.category))}
                            </span>
                          </div>
                          {token.amount && (
                            <div>
                              <strong>Fungible Amount:</strong>{' '}
                              {parseSatoshis(token.amount).toString()}
                            </div>
                          )}
                          {token.nft && (
                            <>
                              <div>
                                <strong>NFT Capability:</strong>{' '}
                                {token.nft.capability}
                              </div>
                              {token.nft.commitment && (
                                <div>
                                  <strong>NFT Commitment:</strong>{' '}
                                  <span className="font-mono break-all">
                                    {binToHex(
                                      ensureUint8Array(token.nft.commitment)
                                    )}
                                  </span>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="text-sm border-t border-[var(--wallet-border)] pt-2">
            <div>Total Input: {Number(totalInput) / SATSINBITCOIN} BCH</div>
            <div>Total Output: {Number(totalOutput) / SATSINBITCOIN} BCH</div>
            <div className="font-semibold">
              Estimated Fee: {Number(fee) / SATSINBITCOIN} BCH
            </div>
            <div>Broadcast: {shouldBroadcast ? 'Yes' : 'No'}</div>
          </div>
        </div>

        <div className="flex justify-around pt-2">
          <button
            onClick={handleSign}
            className="wallet-btn-primary"
            disabled={broadcastLocked}
            title={
              broadcastLocked
                ? 'Wait for the previous outgoing transaction to sync first'
                : undefined
            }
          >
            {broadcastLocked && shouldBroadcast ? 'Waiting for sync' : 'Sign'}
          </button>
          <button onClick={handleCancel} className="wallet-btn-danger">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
