import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { QrStreamDisplay } from '../components/qr/QrStreamDisplay';
import { QrStreamScanner } from '../components/qr/QrStreamScanner';
import PageHeader from '../components/ui/PageHeader';
import SectionCard from '../components/ui/SectionCard';
import WalletScreen from '../components/ui/WalletScreen';
import { createMocknetSigningRequest } from '../services/mocknetSigningFixtures';
import {
  createSigningResponse,
  deserializePartiallySignedTransaction,
  deserializeTransactionSigningResponse,
  serializePartiallySignedTransaction,
  serializeTransactionSigningResponse,
  type PartiallySignedTransaction,
} from '../services/partiallySignedTransaction';

type DemoMode = 'requester' | 'signer';

const formatBytes = (value: Uint8Array) => `${value.length} bytes`;

const QrSigningDemo: React.FC = () => {
  const navigate = useNavigate();
  const [mode, setMode] = useState<DemoMode>('requester');
  const [localRequest, setLocalRequest] = useState<PartiallySignedTransaction | null>(null);
  const [request, setRequest] = useState<PartiallySignedTransaction | null>(null);
  const [responsePayload, setResponsePayload] = useState<Uint8Array | null>(null);
  const [scanResponse, setScanResponse] = useState(false);
  const [responseMessage, setResponseMessage] = useState<string | null>(null);

  const [requestPayload, setRequestPayload] = useState<Uint8Array | null>(null);

  useEffect(() => {
    let cancelled = false;
    void createMocknetSigningRequest()
      .then((nextRequest) => {
        if (cancelled) return;
        setLocalRequest(nextRequest);
        setRequestPayload(serializePartiallySignedTransaction(nextRequest));
      })
      .catch((error) => {
        if (!cancelled) {
          setResponseMessage(error instanceof Error ? error.message : 'Unable to prepare mocknet fixture');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleRequestComplete = useCallback((payload: Uint8Array) => {
    try {
      setRequest(deserializePartiallySignedTransaction(payload));
      setResponseMessage(null);
    } catch (error) {
      setResponseMessage(error instanceof Error ? error.message : 'Invalid signing request');
    }
  }, []);

  const handleResponseComplete = useCallback(
    (payload: Uint8Array) => {
      try {
        const response = deserializeTransactionSigningResponse(payload);
        if (
          !localRequest ||
          response.requestId !== localRequest.metadata.requestId ||
          response.transactionFingerprint !== localRequest.metadata.transactionFingerprint
        ) {
          throw new Error('Signing response does not match this request');
        }
        setResponseMessage(
          response.approved
            ? `Approved by ${response.signerLabel}`
            : `Rejected by ${response.signerLabel}`
        );
        setScanResponse(false);
      } catch (error) {
        setResponseMessage(error instanceof Error ? error.message : 'Invalid signing response');
      }
    },
    [localRequest]
  );

  const approveRequest = () => {
    if (!request) return;
    const response = createSigningResponse({
      request,
      signerLabel: 'Demo signer',
      approved: true,
      inputIndex: request.inputs[0]?.index ?? 0,
      publicKey: '02-demo-public-key',
      signature: 'demo-signature-not-for-broadcast',
    });
    setResponsePayload(serializeTransactionSigningResponse(response));
  };

  return (
    <WalletScreen maxWidthClassName="max-w-md">
      <div className="space-y-4">
        <PageHeader
          title="QR signing demo"
          subtitle="Exchange a partially signed transaction between two OPTN wallet screens."
          compact
        />

        <SectionCard>
          <div className="flex gap-2">
            {(['requester', 'signer'] as const).map((nextMode) => (
              <button
                key={nextMode}
                type="button"
                onClick={() => {
                  setMode(nextMode);
                  setRequest(null);
                  setResponsePayload(null);
                  setScanResponse(false);
                  setResponseMessage(null);
                }}
                className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold ${
                  mode === nextMode
                    ? 'bg-[var(--wallet-accent)] text-black'
                    : 'border border-[var(--wallet-border)] wallet-text-strong'
                }`}
              >
                {nextMode === 'requester' ? 'Request signature' : 'Sign request'}
              </button>
            ))}
          </div>
        </SectionCard>

        {mode === 'requester' ? (
          <>
            <SectionCard title="1. Show request">
              <p className="mb-3 text-sm wallet-text-muted">
                On the other wallet, choose “Sign request” and scan this stream.
              </p>
              {requestPayload ? (
                <div className="mx-auto w-full max-w-[320px] rounded-xl bg-white p-3">
                  <QrStreamDisplay payload={requestPayload} blockLength={360} framesPerSecond={18} />
                </div>
              ) : <p className="text-sm wallet-text-muted">Preparing mocknet fixture…</p>}
              <dl className="mt-3 space-y-1 text-sm">
                <div className="flex justify-between gap-3"><dt className="wallet-text-muted">Network</dt><dd>mocknet</dd></div>
                <div className="flex justify-between gap-3"><dt className="wallet-text-muted">Purpose</dt><dd>{localRequest?.metadata.purpose ?? 'Preparing…'}</dd></div>
                <div className="flex justify-between gap-3"><dt className="wallet-text-muted">Payload</dt><dd>{requestPayload ? formatBytes(requestPayload) : 'Preparing…'}</dd></div>
                <div className="flex justify-between gap-3"><dt className="wallet-text-muted">Fingerprint</dt><dd className="font-mono text-xs">{localRequest?.metadata.transactionFingerprint ?? 'Preparing…'}</dd></div>
              </dl>
            </SectionCard>
            <SectionCard title="2. Collect response">
              {scanResponse ? (
                <QrStreamScanner onComplete={handleResponseComplete} />
              ) : (
                <button type="button" onClick={() => setScanResponse(true)} className="w-full rounded-lg bg-[var(--wallet-accent)] px-3 py-2 text-sm font-semibold text-black">
                  Scan approval response
                </button>
              )}
              {responseMessage ? <p className="mt-3 text-sm wallet-text-strong">{responseMessage}</p> : null}
            </SectionCard>
          </>
        ) : (
          <>
            <SectionCard title="1. Scan request">
              {request ? (
                <div className="space-y-2 text-sm">
                  <p className="font-semibold">Request received</p>
                  <p>Purpose: {request.metadata.purpose}</p>
                  <p>Network: {request.network}</p>
                  <p className="font-mono text-xs">Fingerprint: {request.metadata.transactionFingerprint}</p>
                  <button type="button" onClick={() => setRequest(null)} className="rounded-lg border border-[var(--wallet-border)] px-3 py-2 text-sm">
                    Scan another request
                  </button>
                </div>
              ) : (
                <QrStreamScanner onComplete={handleRequestComplete} />
              )}
            </SectionCard>
            {request ? (
              <SectionCard title="2. Approve and return">
                <p className="mb-3 text-sm wallet-text-muted">
                  This demo returns a placeholder signature and never broadcasts.
                </p>
                <button type="button" onClick={approveRequest} className="w-full rounded-lg bg-[var(--wallet-accent)] px-3 py-2 text-sm font-semibold text-black">
                  Approve demo request
                </button>
                {responsePayload ? (
                  <div className="mt-4 mx-auto w-full max-w-[320px] rounded-xl bg-white p-3">
                    <QrStreamDisplay payload={responsePayload} blockLength={360} framesPerSecond={18} />
                  </div>
                ) : null}
              </SectionCard>
            ) : null}
            {responseMessage ? <p className="text-sm wallet-text-strong">{responseMessage}</p> : null}
          </>
        )}

        <button type="button" onClick={() => navigate(-1)} className="w-full rounded-lg border border-[var(--wallet-border)] px-3 py-2 text-sm font-semibold wallet-text-strong">
          Close
        </button>
      </div>
    </WalletScreen>
  );
};

export default QrSigningDemo;
