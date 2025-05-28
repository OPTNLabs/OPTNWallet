// inside src/components/walletconnect/SignTransactionModal.tsx

import { useSelector, useDispatch } from 'react-redux';
import { RootState, AppDispatch } from '../../redux/store';
import {
  respondWithTxSignature,
  clearPendingSignTx,
  respondWithTxError,
} from '../../redux/walletconnectSlice';
import { binToHex, lockingBytecodeToCashAddress } from '@bitauth/libauth';

function parseOpReturnChunks(bytecode: Uint8Array): string[] {
  const chunks: string[] = ['OP_RETURN'];
  let i = 1;

  while (i < bytecode.length) {
    const op = bytecode[i++];
    if (op === 0x00) {
      chunks.push('OP_0');
    } else if (op >= 0x01 && op <= 0x4b) {
      const len = op;
      const data = bytecode.slice(i, i + len);
      chunks.push(binToHex(data));
      i += len;
    } else if (op === 0x4c) {
      const len = bytecode[i++];
      const data = bytecode.slice(i, i + len);
      chunks.push(binToHex(data));
      i += len;
    } else if (op === 0x4d) {
      const len = bytecode[i] + (bytecode[i + 1] << 8);
      i += 2;
      const data = bytecode.slice(i, i + len);
      chunks.push(binToHex(data));
      i += len;
    } else if (op === 0x4e) {
      const len =
        bytecode[i] +
        (bytecode[i + 1] << 8) +
        (bytecode[i + 2] << 16) +
        (bytecode[i + 3] << 24);
      i += 4;
      const data = bytecode.slice(i, i + len);
      chunks.push(binToHex(data));
      i += len;
    } else {
      chunks.push(`OP_${op.toString(16).padStart(2, '0')}`);
    }
  }

  return chunks;
}

export function SignTransactionModal() {
  const dispatch = useDispatch<AppDispatch>();
  const signTxRequest = useSelector(
    (state: RootState) => state.walletconnect.pendingSignTx
  );
  const activeSessions = useSelector(
    (state: RootState) => state.walletconnect.activeSessions
  );

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

  function ensureUint8Array(input: any): Uint8Array {
    if (input instanceof Uint8Array) return input;
    if (typeof input === 'string' && input.startsWith('<Uint8Array: 0x')) {
      const hex = input.slice('<Uint8Array: 0x'.length, -1);
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
      }
      return bytes;
    }
    return new Uint8Array();
  }

  function parseSatoshis(value: any): bigint {
    try {
      if (typeof value === 'bigint') return value;
      if (typeof value === 'string' && value.startsWith('<bigint:')) {
        const match = value.match(/^<bigint:\s*(\d+)n>$/);
        if (match) return BigInt(match[1]);
      }
      return BigInt(value);
    } catch {
      return 0n;
    }
  }

  function toCashAddress(
    bytecode: any,
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

  const totalInput = sourceOutputs.reduce(
    (sum: bigint, o: any) => sum + parseSatoshis(o.valueSatoshis),
    0n
  );
  const totalOutput = outputs.reduce(
    (sum: bigint, o: any) => sum + parseSatoshis(o.valueSatoshis),
    0n
  );
  const fee = totalInput - totalOutput;

  const handleSign = async () => {
    await dispatch(respondWithTxSignature(signTxRequest));
    dispatch(clearPendingSignTx());
  };

  const handleCancel = async () => {
    await dispatch(respondWithTxError(signTxRequest));
    dispatch(clearPendingSignTx());
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black bg-opacity-70 z-50">
      <div className="bg-white rounded-lg shadow-lg max-w-2xl w-full p-6 flex flex-col space-y-4">
        <h3 className="text-xl font-bold text-center">
          Sign Transaction Request
        </h3>

        <div className="overflow-y-auto max-h-[60vh] space-y-4 pr-1">
          {dappMetadata && (
            <div className="text-sm text-gray-600">
              <div>
                <strong>DApp Name:</strong> {dappMetadata.name}
              </div>
              <div>
                <strong>Domain:</strong>{' '}
                <a
                  href={dappMetadata.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-500 underline"
                >
                  {dappMetadata.url}
                </a>
              </div>
            </div>
          )}

          {userPrompt && (
            <p className="text-sm bg-yellow-100 border border-yellow-300 rounded p-2 text-yellow-900">
              <strong>Prompt:</strong> {userPrompt}
            </p>
          )}

          {inputs.map((_, i: number) => {
            const source = sourceOutputs[i];
            const txid = binToHex(
              ensureUint8Array(source.outpointTransactionHash)
            );
            const value = parseSatoshis(source.valueSatoshis).toString();
            return (
              <div key={i} className="ml-2">
                <div>
                  TXID: <span className="font-mono break-all">{txid}</span>
                </div>
                <div>Index: {source.outpointIndex}</div>
                <div>Value: {value} sats</div>
              </div>
            );
          })}

          {outputs.map((output: any, i: number) => {
            const value = parseSatoshis(output.valueSatoshis).toString();
            const lockingBytecode = ensureUint8Array(output.lockingBytecode);
            const isOpReturn = lockingBytecode[0] === 0x6a;
            const token = output.token;

            if (isOpReturn) {
              const parsed = parsePushData(lockingBytecode);
              return (
                <div key={i} className="ml-2 space-y-1 border-b pb-2 text-sm">
                  <strong>OP_RETURN Output</strong>
                  {parsed.map((data, j) => (
                    <div
                      key={j}
                      className="font-mono text-gray-600 break-words"
                    >
                      {data}
                    </div>
                  ))}
                </div>
              );
            }

            const address = toCashAddress(lockingBytecode, 'bitcoincash');
            return (
              <div key={i} className="ml-2 border-b pb-2 space-y-1">
                <div>
                  Address:{' '}
                  <span className="font-mono text-blue-600 break-all">
                    {address}
                  </span>
                </div>
                <div>Value: {value} sats</div>
                {token && (
                  <div className="text-sm bg-green-50 border border-green-200 rounded p-2 space-y-1">
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
                              {binToHex(ensureUint8Array(token.nft.commitment))}
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

          <div className="text-sm border-t pt-2">
            <div>Total Input: {totalInput.toString()} sats</div>
            <div>Total Output: {totalOutput.toString()} sats</div>
            <div className="font-semibold">
              Estimated Fee: {fee.toString()} sats
            </div>
            <div>Broadcast: {shouldBroadcast ? 'Yes' : 'No'}</div>
          </div>
        </div>

        <div className="flex justify-around pt-2">
          <button
            onClick={handleSign}
            className="px-4 py-2 bg-green-500 hover:bg-green-600 text-white rounded"
          >
            Sign
          </button>
          <button
            onClick={handleCancel}
            className="px-4 py-2 bg-red-500 hover:bg-red-600 text-white rounded"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
